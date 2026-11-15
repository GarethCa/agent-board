// Main's IPC answers only the app's own windows. Main's entry imports this first, so the guard is on `ipcMain` before
// any module can register a handler or listener, and every one after it, written now or later, is checked without
// asking for it (`ipc-guard.ts`).
import { ipcMain } from 'electron';
import { isAppPage } from './app-windows';
import { guardIpc } from './ipc-guard';

guardIpc(ipcMain, isAppPage);
