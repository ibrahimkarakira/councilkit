#!/usr/bin/env node
// An invented todo list, small enough to read in a minute: the toy project of the councilkit demo.
// Items live in todos.json in the current directory, or in $TODO_FILE.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const file = () => process.env.TODO_FILE ?? 'todos.json';

function load() {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

const save = (items) => writeFileSync(file(), `${JSON.stringify(items, null, 2)}\n`);

// Returns the exit code; `out` receives one line at a time.
export function run([command, ...args], out = console.log) {
  const items = load();
  const n = Number(args[0]);
  if (command === 'add' && args.length) {
    save([...items, { name: args.join(' '), done: false }]);
  } else if (command === 'done' && Number.isInteger(n) && items[n - 1]) {
    save(items.map((item, i) => (i === n - 1 ? { ...item, done: true } : item)));
  } else if (command === 'list') {
    items.forEach((item, i) => out(`${i + 1}. [${item.done ? 'x' : ' '}] ${item.name}`));
  } else {
    console.error('usage: todo add <text> | todo done <n> | todo list');
    return 2;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
