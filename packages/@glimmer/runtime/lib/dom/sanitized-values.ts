import { Option } from '@glimmer/util';
import { normalizeStringValue, isSafeString } from '../dom/normalize';
import { SimpleElement } from '@simple-dom/interface';

const badProtocols = ['javascript:', 'vbscript:'];

const badTags = ['A', 'BODY', 'LINK', 'IMG', 'IFRAME', 'BASE', 'FORM'];

const badTagsForDataURI = ['EMBED'];

const badAttributes = ['href', 'src', 'background', 'action'];

const badAttributesForDataURI = ['src'];

function has(array: Array<string>, item: string): boolean {
  return array.indexOf(item) !== -1;
}

function checkURI(tagName: Option<string>, attribute: string): boolean {
  return (tagName === null || has(badTags, tagName)) && has(badAttributes, attribute);
}

function checkDataURI(tagName: Option<string>, attribute: string): boolean {
  if (tagName === null) return false;
  return has(badTagsForDataURI, tagName) && has(badAttributesForDataURI, attribute);
}

export function requiresSanitization(tagName: string, attribute: string): boolean {
  return checkURI(tagName, attribute) || checkDataURI(tagName, attribute);
}

let protocolForUrl: (url: string) => string;

// TODO: We should replace these methods with something more modern https://github.com/glimmerjs/glimmer-vm/issues/1140
if (typeof document !== 'undefined') {
  let parsingNode = document.createElement('a');

  protocolForUrl = (url: string) => {
    parsingNode.href = url;
    return parsingNode.protocol;
  };
} else {
  let nodeURL = module.require('url');

  protocolForUrl = (url: string) => {
    let protocol = null;

    if (typeof url === 'string') {
      protocol = nodeURL.parse(url).protocol;
    }

    return protocol === null ? ':' : protocol;
  };
}

export function sanitizeAttributeValue(
  element: SimpleElement,
  attribute: string,
  value: unknown
): unknown {
  let tagName: Option<string> = null;

  if (value === null || value === undefined) {
    return value;
  }

  if (isSafeString(value)) {
    return value.toHTML();
  }

  if (!element) {
    tagName = null;
  } else {
    tagName = element.tagName.toUpperCase();
  }

  let str = normalizeStringValue(value);

  if (checkURI(tagName, attribute)) {
    let protocol = protocolForUrl(str);
    if (has(badProtocols, protocol)) {
      return `unsafe:${str}`;
    }
  }

  if (checkDataURI(tagName, attribute)) {
    return `unsafe:${str}`;
  }

  return str;
}
