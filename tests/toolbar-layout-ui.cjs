const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-toolbar-'));
  const python = process.env.CAIDAN_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
  const server = spawn(python, ['-u', '-m', 'server.app', '--port', '0'], {
    cwd: root, env: { ...process.env, CAIDAN_DATA: path.join(temp, 'data') }, windowsHide: true
  });
  let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('服务启动超时')), 30000);
      server.on('error', reject);
      server.on('exit', code => reject(new Error(`服务退出：${code}`)));
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/Caidan running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1395, height: 892 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#inventory');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const inventoryPanel = page.locator('.inventory-page > .panel').first();
    const inventoryCard = page.locator('.inventory-page > .inventory-summary');
    await inventoryCard.waitFor();
    const box = async locator => locator.evaluate(node => { const rect = node.getBoundingClientRect(); return { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top) }; });
    const inventorySummary = await box(inventoryCard);
    const inventorySummaryHeight = await inventoryCard.evaluate(node => Math.round(node.getBoundingClientRect().height));
    assert.equal(inventorySummaryHeight, 70, `库存卡片行高应为 70px（实际 ${inventorySummaryHeight}）`);
    const inventoryMetrics = await page.evaluate(() => {
      const card = document.querySelector('.inventory-page > .inventory-summary');
      const cell = card.querySelector(':scope > div');
      const probe = document.createElement('span');
      probe.style.color = 'var(--teal)';
      document.body.appendChild(probe);
      const teal = getComputedStyle(probe).color;
      probe.remove();
      return {
        cardTop: card.getBoundingClientRect().top, cardBottom: card.getBoundingClientRect().bottom,
        labelTop: cell.querySelector('small').getBoundingClientRect().top, valueBottom: cell.querySelector('strong').getBoundingClientRect().bottom,
        color: getComputedStyle(cell.querySelector('strong')).color, teal,
      };
    });
    assert.ok(Math.abs((inventoryMetrics.labelTop - inventoryMetrics.cardTop) - (inventoryMetrics.cardBottom - inventoryMetrics.valueBottom)) <= 1.5, `库存卡片上下留白应一致（上 ${(inventoryMetrics.labelTop - inventoryMetrics.cardTop).toFixed(1)} / 下 ${(inventoryMetrics.cardBottom - inventoryMetrics.valueBottom).toFixed(1)}）`);
    assert.equal(inventoryMetrics.color, inventoryMetrics.teal, '库存数字应使用主题色');
    const inventoryToolbar = await box(inventoryPanel.locator('.toolbar'));
    assert.ok(inventorySummary.top < inventoryToolbar.top, '库存汇总应位于搜索栏上方');
    const inventoryGap = await page.evaluate(() => {
      const card = document.querySelector('.inventory-page > .inventory-summary');
      const panel = document.querySelector('.inventory-page > .panel');
      return panel.getBoundingClientRect().top - card.getBoundingClientRect().bottom;
    });
    assert.ok(Math.abs(inventoryGap - 5) < 1, `库存卡片与下方容器应间隔 5px（实际 ${inventoryGap}）`);
    const inventoryActions = await box(inventoryPanel.locator('.inventory-overview-toolbar .toolbar-actions'));
    const inventorySearch = await box(inventoryPanel.locator('.inventory-overview-toolbar .search'));
    assert.ok(inventoryActions.right <= inventorySearch.left, `库存按钮应在搜索栏左侧（${inventoryActions.right} / ${inventorySearch.left}）`);
    assert.ok(Math.abs((inventorySearch.left - inventoryActions.right) - 10) <= 1, `库存按钮与搜索栏间距应为 10px（实际 ${inventorySearch.left - inventoryActions.right}）`);
    await page.screenshot({ path: path.join(temp, 'inventory.png') });

    await page.goto(origin + '/#sales-invoices');
    const invoiceToolbar = page.locator('.sales-invoices .toolbar');
    await invoiceToolbar.locator('.purchase-toolbar-actions').waitFor();
    const invoiceActions = await box(invoiceToolbar.locator('.purchase-toolbar-actions'));
    const invoiceSearch = await box(invoiceToolbar.locator('.search'));
    assert.ok(invoiceActions.right <= invoiceSearch.left, `发票按钮应在搜索栏左侧（${invoiceActions.right} / ${invoiceSearch.left}）`);
    assert.ok(Math.abs((invoiceSearch.left - invoiceActions.right) - 10) <= 1, `发票按钮与搜索栏间距应为 10px（实际 ${invoiceSearch.left - invoiceActions.right}）`);
    const billing = invoiceToolbar.getByRole('button', { name: '开票信息', exact: true });
    await billing.waitFor();
    const billingRight = await billing.evaluate(node => Math.round(node.getBoundingClientRect().right));
    const toolbarRight = await invoiceToolbar.evaluate(node => Math.round(node.getBoundingClientRect().right));
    assert.ok(toolbarRight - billingRight <= 40, `开票信息应位于发票按钮栏最右侧（${billingRight} / ${toolbarRight}）`);
    await page.screenshot({ path: path.join(temp, 'sales-invoices.png') });

    for (const route of ['#orders', '#products', '#inventory', '#purchases', '#sales-invoices', '#customers']) {
      await page.goto(origin + '/' + route);
      const toolbar = page.locator('main .toolbar').first();
      await toolbar.waitFor();
      const style = await toolbar.evaluate(el => {
        const computed = getComputedStyle(el);
        return { pt: computed.paddingTop, pb: computed.paddingBottom, cg: computed.columnGap, rg: computed.rowGap };
      });
      assert.equal(style.pt, '10px', `${route} 工具栏上间距应为 10px`);
      assert.equal(style.pb, '10px', `${route} 工具栏下间距应为 10px`);
      assert.equal(style.cg, '10px', `${route} 工具栏水平间隙应为 10px`);
      assert.equal(style.rg, '10px', `${route} 工具栏垂直间隙应为 10px`);
    }
    await page.goto(origin + '/#purchases');
    await page.locator('.purchases-list .toolbar').waitFor();
    assert.equal(await page.getByRole('button', { name: '开票信息', exact: true }).count(), 0, '采购页不应再有开票信息按钮');
    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 库存汇总置顶、库存与发票按钮在搜索栏左侧；截图：', temp);
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
