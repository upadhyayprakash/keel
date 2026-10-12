#!/usr/bin/env node
// Runs the TypeScript entry point through tsx until Keel ships a compiled build.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
