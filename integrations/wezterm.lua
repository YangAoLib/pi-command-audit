-- Pi 审批仅做状态提示，不接受批准凭据、不执行命令、不抢焦点。
-- 由现有 wezterm.lua 显式 dofile 加载，保持配色来自原主题。
local wezterm = require 'wezterm'
local M = {}

local function pending_count(tab)
  local count = 0
  for _, pane in ipairs(tab.panes or { tab.active_pane }) do
    local raw = (pane.user_vars or {}).PI_AUDIT_APPROVAL
    if raw and #raw < 2048 then
      local ok, state = pcall(wezterm.json_parse, raw)
      if ok and type(state) == 'table' and state.version == 1 and state.pending == true
          and type(state.expiresAt) == 'number' and state.expiresAt > os.time() * 1000 then
        count = count + 1
      end
    end
  end
  return count
end

function M.setup()
  wezterm.on('format-tab-title', function(tab, tabs, panes, config, hover, max_width)
    local count = pending_count(tab)
    -- 没有待审批时不改变默认标题，也不覆盖用户设置的 tab title。
    if count == 0 then return nil end
    local title = tab.tab_title
    if not title or #title == 0 then title = tab.active_pane.title end
    local text = '[审批 ' .. tostring(count) .. '] ' .. title
    return { { Text = wezterm.truncate_right(text, math.max(1, max_width - 2)) } }
  end)
  -- 强制退出后按截止时间忽略旧状态；下一次标签重绘时恢复默认标题。
end

return M
