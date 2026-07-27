-- lattice-fs neovim glue. Source this and set the mount root, e.g.:
--   vim.g.lattice_mount = vim.fn.expand('~/lattice')
--   vim.cmd('source ' .. '/path/to/lattice-fs/nvim/lattice-fs.lua')
--
-- Two behaviours for buffers under the mount:
--  1. backupcopy=yes  -> vim writes in place, so one :w = one page-save = one
--     eval (no write-temp+rename churn on the FUSE tree).
--  2. BufWritePost    -> after the async evaluator runs, pull the page's error
--     text into the quickfix list (empty = clear + close).

local function under_mount(path)
  local root = vim.g.lattice_mount
  return root ~= nil and path:sub(1, #root) == root
end

local grp = vim.api.nvim_create_augroup('LatticeFs', { clear = true })

-- Keep vim's backup copies OFF the mount. A `<name>.md~` written into the tree
-- would map to the page's own projection rel and clobber it. Backups for every
-- buffer go to this off-tree cache dir instead. (Global; backupdir is not
-- buffer-local in neovim.)
local bdir = vim.fn.stdpath('cache') .. '/lattice-fs-backup'
vim.fn.mkdir(bdir, 'p')
vim.opt.backupdir = bdir

vim.api.nvim_create_autocmd({ 'BufReadPre', 'BufNewFile' }, {
  group = grp,
  callback = function(ev)
    if under_mount(vim.fn.expand('%:p')) then
      -- write in place, so one :w = one page-save = one eval (no rename churn)
      vim.bo[ev.buf].backupcopy = 'yes'
    end
  end,
})

vim.api.nvim_create_autocmd('BufWritePost', {
  group = grp,
  callback = function()
    local f = vim.fn.expand('%:p')
    if not under_mount(f) then return end
    local root = vim.g.lattice_mount
    local rel = f:sub(#root + 2):gsub('%.%w+$', '')   -- strip mount prefix + ext
    -- defer: let the async evaluator write the err grub first
    vim.defer_fn(function()
      local out = vim.fn.systemlist({ 'lattice-fs', 'errors', rel })
      local nonempty = #out > 0 and table.concat(out):match('%S') ~= nil
      if nonempty then
        vim.fn.setqflist({}, 'r', { title = 'lattice', lines = out })
        vim.cmd('copen')
      else
        vim.fn.setqflist({}, 'r', { title = 'lattice', lines = {} })
        vim.cmd('cclose')
      end
    end, 400)
  end,
})
