// 本机手动冒烟：不执行任何业务命令，验证真实 Windows Toast 的显示和按钮回调。
import assert from 'node:assert/strict';
import { createApproval } from '../approval-state.ts';
import { startDesktopApproval } from '../desktop-approval.ts';
const seconds = process.argv.includes('--probe') ? 3 : 60;
const state = createApproval('desktop-smoke', 'a'.repeat(64), Date.now() + seconds * 1000);
const close = startDesktopApproval(state, 'Pi 二阶段按钮测试', '不执行命令。请点击允许或拒绝，检查本终端是否立即返回对应结果。', () => state.settle('error'));
assert.ok(close, '本机未安装桌面辅助程序');
console.log('等待桌面操作；只有测试状态发生变化，不会执行命令。');
try {
  const result = await state.result;
  console.log('测试结果：' + result);
  if (result === 'error') process.exitCode = 1;
} finally { close(); state.dispose(); }
