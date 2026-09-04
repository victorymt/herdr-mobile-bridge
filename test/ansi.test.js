import test from 'node:test';
import assert from 'node:assert/strict';

import { ansiToText, parseAnsi } from '../public/ansi.js';

test('ANSI parser preserves text and common foreground styles', () => {
  const segments = parseAnsi('\u001b[1;31mblocked\u001b[0m\nnext');
  assert.deepEqual(segments, [
    {
      text: 'blocked',
      style: {
        foreground: '#cd3131',
        background: null,
        bold: true,
        dim: false,
        italic: false,
        underline: false,
        inverse: false,
        strike: false,
      },
    },
    {
      text: '\nnext',
      style: {
        foreground: null,
        background: null,
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        inverse: false,
        strike: false,
      },
    },
  ]);
});

test('ANSI parser supports indexed and true-color styles with resets', () => {
  const segments = parseAnsi('\u001b[38;5;202morange\u001b[48;2;1;2;3m bg\u001b[39;49m plain');
  assert.equal(segments[0].style.foreground, 'rgb(255, 95, 0)');
  assert.equal(segments[1].style.foreground, 'rgb(255, 95, 0)');
  assert.equal(segments[1].style.background, 'rgb(1, 2, 3)');
  assert.equal(segments[2].style.foreground, null);
  assert.equal(segments[2].style.background, null);
  assert.equal(ansiToText('\u001b[4mchoose\u001b[24m: \u001b[2Kready'), 'choose: ready');
});

test('ANSI parser removes OSC and unsupported terminal controls for safe clipboard text', () => {
  const input = 'before\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 after\u001b[2J\u001b[?25l';
  assert.equal(ansiToText(input), 'beforelink after');
  assert.doesNotMatch(ansiToText(input), /https?:|\u001b|\u0007/);
});

