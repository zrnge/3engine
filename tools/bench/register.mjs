// node --import ./tools/bench/register.mjs …: resolve `three` as the page does (hooks.mjs)
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
