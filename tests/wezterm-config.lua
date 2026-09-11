-- 使用 wezterm --config-file <本文件绝对路径> show-keys 执行，不发送通知或启动任务。
local real = require 'wezterm'
local handlers = {}
package.loaded.wezterm = {
  on = function(name, fn) handlers[name] = fn end,
  json_parse = real.json_parse,
  truncate_right = real.truncate_right,
}
local here = debug.getinfo(1, 'S').source:sub(2):match('^(.*)[/\\]')
local audit = dofile(here .. '/../integrations/wezterm.lua')
audit.setup()
package.loaded.wezterm = real

local function pane(pending, expires)
  return { title = '原始标题', user_vars = {
    PI_AUDIT_APPROVAL = real.json_encode({ version = 1, pending = pending, expiresAt = expires }),
  } }
end
local future = (os.time() + 60) * 1000
local formatter = handlers['format-tab-title']
local active = pane(true, future)
local result = formatter({ tab_title = '自定义标题', active_pane = active, panes = { active, pane(true, future) } }, {}, {}, {}, false, 60)
assert(result[1].Text:find('[审批 2]', 1, true))
assert(result[1].Text:find('自定义标题', 1, true))
assert(formatter({ active_pane = pane(false, 0) }, {}, {}, {}, false, 60) == nil)
assert(formatter({ active_pane = pane(true, 0) }, {}, {}, {}, false, 60) == nil)
assert(formatter({ active_pane = { user_vars = { PI_AUDIT_APPROVAL = '无效JSON' } } }, {}, {}, {}, false, 60) == nil)
local restore_count, focus_count, maximize_count = 0, 0, 0
local window = {
  restore = function() restore_count = restore_count + 1 end,
  maximize = function() maximize_count = maximize_count + 1 end,
  focus = function() focus_count = focus_count + 1 end,
}
local focus_pane = { get_user_vars = function() return {
  PI_AUDIT_APPROVAL = real.json_encode({ version = 1, id = 'request-1', pending = true, expiresAt = future })
} end }
local request = { version = 1, id = 'request-1', deadline = future, requestedAt = os.time() * 1000 }
local changed = handlers['user-var-changed']
changed(window, focus_pane, 'PI_AUDIT_FOCUS', real.json_encode(request))
assert(restore_count == 0 and maximize_count == 1 and focus_count == 1)
request.id = 'wrong'
changed(window, focus_pane, 'PI_AUDIT_FOCUS', real.json_encode(request))
request.id = 'request-1'
request.requestedAt = (os.time() - 10) * 1000
changed(window, focus_pane, 'PI_AUDIT_FOCUS', real.json_encode(request))
assert(restore_count == 0 and maximize_count == 1 and focus_count == 1)
-- 有效返回请求始终先最大化再聚焦；最小化状态也不经过普通尺寸恢复。
for _, mode in ipairs({ 'normal', 'minimized', 'maximized' }) do
  local calls = {}
  local mock = {
    restore = function() error('不得恢复为普通窗口') end,
    maximize = function() table.insert(calls, 'maximize') end,
    focus = function() table.insert(calls, 'focus') end,
  }
  request.requestedAt = os.time() * 1000
  changed(mock, focus_pane, 'PI_AUDIT_FOCUS', real.json_encode(request))
  assert(table.concat(calls, ',') == 'maximize,focus', mode)
end
return {}
