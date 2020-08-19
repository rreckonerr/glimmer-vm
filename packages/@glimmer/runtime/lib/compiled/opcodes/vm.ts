import { CompilableTemplate, Option, Op } from '@glimmer/interfaces';
import { isModified, ReferenceCache } from '@glimmer/reference';
import {
  CONSTANT_TAG,
  Revision,
  Tag,
  valueForTag,
  validateTag,
  INITIAL,
  beginTrackFrame,
  endTrackFrame,
  consumeTag,
} from '@glimmer/validator';
import { assert, decodeHandle, expect, isNonPrimitiveHandle } from '@glimmer/util';
import {
  CheckNumber,
  check,
  CheckInstanceof,
  CheckOption,
  CheckBlockSymbolTable,
  CheckHandle,
  CheckPrimitive,
} from '@glimmer/debug';
import { stackAssert } from './assert';
import { APPEND_OPCODES, UpdatingOpcode } from '../../opcodes';
import { PrimitiveReference, ConditionalReference } from '../../references';
import { UpdatingVM } from '../../vm';
import { VMArgumentsImpl } from '../../vm/arguments';
import { CheckReference, CheckScope } from './-debug-strip';
import { CONSTANTS } from '../../symbols';
import { InternalJitVM } from '../../vm/append';

APPEND_OPCODES.add(Op.ChildScope, vm => vm.pushChildScope());

APPEND_OPCODES.add(Op.PopScope, vm => vm.popScope());

APPEND_OPCODES.add(Op.PushDynamicScope, vm => vm.pushDynamicScope());

APPEND_OPCODES.add(Op.PopDynamicScope, vm => vm.popDynamicScope());

APPEND_OPCODES.add(Op.Constant, (vm, { op1: other }) => {
  vm.stack.pushJs(vm[CONSTANTS].getValue(decodeHandle(other)));
});

APPEND_OPCODES.add(Op.Primitive, (vm, { op1: primitive }) => {
  let stack = vm.stack;

  if (isNonPrimitiveHandle(primitive)) {
    // it is a handle which does not already exist on the stack
    let value = vm[CONSTANTS].getValue(decodeHandle(primitive));
    stack.pushJs(value as object);
  } else {
    // is already an encoded immediate or primitive handle
    stack.pushRaw(primitive);
  }
});

APPEND_OPCODES.add(Op.PrimitiveReference, vm => {
  let stack = vm.stack;
  stack.pushJs(PrimitiveReference.create(check(stack.pop(), CheckPrimitive)));
});

APPEND_OPCODES.add(Op.ReifyU32, vm => {
  let stack = vm.stack;
  stack.pushSmallInt(check(check(stack.peekJs(), CheckReference).value(), CheckNumber));
});

APPEND_OPCODES.add(Op.Dup, (vm, { op1: register, op2: offset }) => {
  let position = check(vm.fetchValue(register), CheckNumber) - offset;
  vm.stack.dup(position);
});

APPEND_OPCODES.add(Op.Pop, (vm, { op1: count }) => {
  vm.stack.pop(count);
});

APPEND_OPCODES.add(Op.Load, (vm, { op1: register }) => {
  vm.load(register);
});

APPEND_OPCODES.add(Op.Fetch, (vm, { op1: register }) => {
  vm.fetch(register);
});

APPEND_OPCODES.add(Op.BindDynamicScope, (vm, { op1: _names }) => {
  let names = vm[CONSTANTS].getArray<string>(_names);
  vm.bindDynamicScope(names);
});

APPEND_OPCODES.add(Op.Enter, (vm, { op1: args }) => {
  vm.enter(args);
});

APPEND_OPCODES.add(Op.Exit, vm => {
  vm.exit();
});

APPEND_OPCODES.add(Op.PushSymbolTable, (vm, { op1: _table }) => {
  let stack = vm.stack;
  stack.pushJs(vm[CONSTANTS].getSerializable(_table));
});

APPEND_OPCODES.add(Op.PushBlockScope, vm => {
  let stack = vm.stack;
  stack.pushJs(vm.scope());
});

APPEND_OPCODES.add(
  Op.CompileBlock,
  (vm: InternalJitVM) => {
    let stack = vm.stack;
    let block = stack.pop<Option<CompilableTemplate> | 0>();

    if (block) {
      stack.pushSmallInt(vm.compile(block));
    } else {
      stack.pushNull();
    }
  },
  'jit'
);

APPEND_OPCODES.add(Op.InvokeYield, vm => {
  let { stack } = vm;

  let handle = check(stack.pop(), CheckOption(CheckHandle));
  let scope = check(stack.popJs(), CheckOption(CheckScope));
  let table = check(stack.popJs(), CheckOption(CheckBlockSymbolTable));

  assert(
    table === null || (table && typeof table === 'object' && Array.isArray(table.parameters)),
    stackAssert('Option<BlockSymbolTable>', table)
  );

  let args = check(stack.pop(), CheckInstanceof(VMArgumentsImpl));

  if (table === null) {
    // To balance the pop{Frame,Scope}
    vm.pushFrame();
    vm.pushScope(scope!); // Could be null but it doesnt matter as it is immediatelly popped.
    return;
  }

  let invokingScope = scope!;

  // If necessary, create a child scope
  {
    let locals = table.parameters;
    let localsCount = locals.length;

    if (localsCount > 0) {
      invokingScope = invokingScope.child();

      for (let i = 0; i < localsCount; i++) {
        invokingScope.bindSymbol(locals![i], args.at(i));
      }
    }
  }

  vm.pushFrame();
  vm.pushScope(invokingScope);
  vm.call(handle!);
});

APPEND_OPCODES.add(Op.JumpIf, (vm, { op1: target }) => {
  let reference = check(vm.stack.popJs(), CheckReference);
  let value = Boolean(reference.value());

  if (reference.isConst()) {
    if (value === true) {
      vm.goto(target);
    }
  } else {
    let cache = new ReferenceCache(reference);

    if (value === true) {
      vm.goto(target);
    }

    vm.updateWith(new Assert(cache));
  }
});

APPEND_OPCODES.add(Op.JumpUnless, (vm, { op1: target }) => {
  let reference = check(vm.stack.popJs(), CheckReference);
  let value = Boolean(reference.value());

  if (reference.isConst()) {
    if (value === false) {
      vm.goto(target);
    }
  } else {
    let cache = new ReferenceCache(reference);

    if (value === false) {
      vm.goto(target);
    }

    vm.updateWith(new Assert(cache));
  }
});

APPEND_OPCODES.add(Op.JumpEq, (vm, { op1: target, op2: comparison }) => {
  let other = check(vm.stack.peekSmallInt(), CheckNumber);

  if (other === comparison) {
    vm.goto(target);
  }
});

APPEND_OPCODES.add(Op.AssertSame, vm => {
  let reference = check(vm.stack.peekJs(), CheckReference);

  if (!reference.isConst()) {
    vm.updateWith(new Assert(new ReferenceCache(reference)));
  }
});

APPEND_OPCODES.add(Op.ToBoolean, vm => {
  let { stack } = vm;
  let inner = check(stack.popJs(), CheckReference);
  stack.pushJs(new ConditionalReference(inner));
});

export class Assert extends UpdatingOpcode {
  public type = 'assert';

  constructor(private cache: ReferenceCache<unknown>) {
    super();
  }

  evaluate(vm: UpdatingVM) {
    let { cache } = this;

    if (isModified(cache.revalidate())) {
      vm.throw();
    }
  }
}

export class JumpIfNotModifiedOpcode extends UpdatingOpcode {
  public type = 'jump-if-not-modified';

  private tag: Tag = CONSTANT_TAG;
  private lastRevision: Revision = INITIAL;
  private target?: number;

  finalize(tag: Tag, target: number) {
    this.target = target;
    this.didModify(tag);
  }

  evaluate(vm: UpdatingVM) {
    let { tag, target, lastRevision } = this;

    if (!vm.alwaysRevalidate && validateTag(tag, lastRevision)) {
      consumeTag(tag);
      vm.goto(expect(target, 'VM BUG: Target must be set before attempting to jump'));
    }
  }

  didModify(tag: Tag) {
    this.tag = tag;
    this.lastRevision = valueForTag(this.tag);
    consumeTag(tag);
  }
}

export class BeginTrackFrameOpcode extends UpdatingOpcode {
  public type = 'begin-track-frame';

  constructor(private debugLabel?: string) {
    super();
  }

  evaluate() {
    beginTrackFrame(this.debugLabel);
  }
}

export class EndTrackFrameOpcode extends UpdatingOpcode {
  public type = 'end-track-frame';

  constructor(private target: JumpIfNotModifiedOpcode) {
    super();
  }

  evaluate() {
    let tag = endTrackFrame();
    this.target.didModify(tag);
  }
}
