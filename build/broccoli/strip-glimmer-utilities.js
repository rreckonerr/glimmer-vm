'use strict';

const babel = require('broccoli-babel-transpiler');
const stripGlimmerUtils = require('babel-plugin-strip-glimmer-utils');
const debugMacros = require('babel-plugin-debug-macros');
const nuke = require('babel-plugin-nukable-import');
const nameResolver = require('amd-name-resolver').moduleResolve;

/**
 * Optimizes out Glimmer utility functions and strips debug code with a set of
 * Babel plugins.
 */
module.exports = function (jsTree) {
  let RETAIN_FLAGS = process.env.RETAIN_FLAGS;
  let glimmerUtils = [];

  if (!RETAIN_FLAGS) {
    stripFlags(glimmerUtils);
  }

  return babel(jsTree, {
    annotation: 'Babel - Strip Glimmer Utilities',
    sourceMaps: 'inline',
    moduleIds: true,
    getModuleId: nameResolver,
    plugins: [
      ...glimmerUtils,
      [
        stripGlimmerUtils,
        {
          bindings: ['castToSimple', 'castToBrowser', 'expect', 'unwrap'],
          source: '@glimmer/util',
        },
      ],
    ],
  });
};

function stripFlags(glimmerUtils) {
  glimmerUtils.push([
    debugMacros,
    {
      flags: [
        {
          source: '@glimmer/local-debug-flags',
          flags: {
            LOCAL_DEBUG: process.env.EMBER_ENV !== 'production',
            LOCAL_SHOULD_LOG: process.env.EMBER_ENV !== 'production',
          },
        },
      ],
      debugTools: {
        isDebug: process.env.EMBER_ENV !== 'production',
        source: '@glimmer/util',
      },
      externalizeHelpers: {
        module: true,
      },
    },
  ]);
  glimmerUtils.push([
    nuke,
    {
      source: '@glimmer/debug',
      delegate: removeLogging,
    },
    'nuke-debug-logging',
  ]);
  glimmerUtils.push([nuke, { source: '@glimmer/debug' }, 'nuke-debug']);
  glimmerUtils.push([nuke, { source: '@glimmer/vm/lib/-debug-strip' }, 'nuke-vm-debug-strip']);
  glimmerUtils.push([
    nuke,
    { source: '@glimmer/runtime/lib/compiled/opcodes/-debug-strip' },
    'nuke-opcodes-debug-strip',
  ]);
  glimmerUtils.push([nuke, { source: './-debug-strip' }, 'nuke-debug-strip']);
  glimmerUtils.push([
    nuke,
    {
      source: '@glimmer/vm',
      delegate: removeMetaData,
    },
    'nuke-vm-metadata',
  ]);
}

function removeMetaData(bindingName, path, t) {
  if (bindingName === 'METADATA') {
    path.parentPath.replaceWith(t.nullLiteral());
  }
}

function removeLogging(bindingName, path, t) {
  if (bindingName === 'debugSlice') {
    path.parentPath.remove();
  }

  if (bindingName === 'debug') {
    path.parentPath.replaceWith(t.arrayExpression());
  }

  if (bindingName === 'logOpcode') {
    path.parentPath.replaceWith(t.stringLiteral(''));
  }
}

removeLogging.baseDir = nuke.baseDir;
removeMetaData.baseDir = nuke.baseDir;
