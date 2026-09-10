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
return {}
