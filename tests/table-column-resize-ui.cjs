const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-column-resize-'));
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
      server.on('exit', code => reject(new Error('服务已退出 ' + code)));
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/Caidan running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1575, height: 892 } });
    const errors = [];
    page.on('pageerror', error => errors.push('pageerror: ' + error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
    await page.goto(origin + '/#customers');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    const setup = await page.getByLabel('姓名', { exact: true }).count();
    if (setup) await page.getByLabel('姓名', { exact: true }).fill('管理员');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: setup ? '创建并进入' : '登录', exact: true }).click();
    await page.locator('.customer-list .toolbar').waitFor({ timeout: 20000 });
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      return payload;
    }, { route, body });
    await post('/customers', { name: '列宽客户', contacts: [{ name: '张工', phone: '13800000001' }], addresses: [{ address: '列宽测试路 1 号', contact: '张工', phone: '13800000001' }] });
    await page.reload();

    const table = page.locator('.customer-list .table-scroll').first();
    await table.locator('thead th').first().waitFor({ timeout: 20000 });
    const headerWidths = () => table.locator('thead th').evaluateAll(ths => ths.map(th => Math.round(th.getBoundingClientRect().width)));
    const before = await headerWidths();
    assert.equal(before.length, 7, '客户列表 7 列');
    assert.equal(await table.locator('.col-resize-handle').count(), 7, '每列表头都有列宽把手');

    // 拖动第一列（客户名称）右缘 +140px：本列变宽，相邻列最多让到 84px，其余由表格横向滚动承担
    const handle = table.locator('thead th').first().locator('.col-resize-handle');
    const box = await handle.boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 140, y, { steps: 8 });
    await page.mouse.up();
    const after = await headerWidths();
    assert.ok(Math.abs(after[0] - (before[0] + 140)) <= 4, `第一列应加宽约 140px：${before[0]} -> ${after[0]}`);
    assert.ok(after[1] <= before[1] && after[1] >= 83, `相邻列让出宽度但不低于 84px：${before[1]} -> ${after[1]}`);
    const scrolled = await table.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    assert.ok(scrolled.scroll > scrolled.client + 1, `拉宽后可横向滚动：${JSON.stringify(scrolled)}`);
    await table.screenshot({ path: path.join(temp, 'customers-columns.png') });
    const cellWidth = await page.locator('.customer-list tbody tr').first().locator('td').first().evaluate(td => Math.round(td.getBoundingClientRect().width));
    assert.ok(Math.abs(cellWidth - after[0]) <= 2, `表体列宽跟随表头：${cellWidth} / ${after[0]}`);

    // 列宽按账号保存到服务端，刷新后沿用
    const saved = await page.evaluate(async () => (await (await fetch('/api/auth/status')).json()).user.column_settings.widths || {});
    const savedList = Object.values(saved).find(list => Array.isArray(list) && Math.abs(Number(list[0]) - after[0]) <= 2);
    assert.ok(savedList, '列宽已按账号保存：' + JSON.stringify(saved));
    await page.reload();
    await table.locator('thead th').first().waitFor({ timeout: 20000 });
    const reloaded = await headerWidths();
    assert.ok(Math.abs(reloaded[0] - after[0]) <= 2, `刷新后应沿用列宽：${after[0]} -> ${reloaded[0]}`);

    // 双击把手恢复默认
    await table.locator('thead th').first().locator('.col-resize-handle').dblclick();
    const reset = await headerWidths();
    assert.ok(Math.abs(reset[0] - before[0]) <= 2, `双击应恢复默认列宽：${before[0]} -> ${reset[0]}`);

    // 全局：其他明细栏同样带列宽把手
    await page.goto(origin + '/#orders');
    await page.locator('.orders-list thead th').first().waitFor({ timeout: 20000 });
    const orderColumns = await page.locator('.orders-list thead th').count();
    assert.ok(orderColumns > 8, '订单列表列数正常：' + orderColumns);
    assert.equal(await page.locator('.orders-list .col-resize-handle').count(), orderColumns, '订单明细栏同样可调列宽');

    await page.goto(origin + '/#inventory');
    await page.locator('.inventory-page thead th').first().waitFor({ timeout: 20000 });
    const inventoryColumns = await page.locator('.inventory-page thead th').count();
    assert.ok(inventoryColumns > 4, '库存页列数正常：' + inventoryColumns);
    assert.equal(await page.locator('.inventory-page .col-resize-handle').count(), inventoryColumns, '库存明细栏同样可调列宽');

    // 报表（采购明细／发票汇总）：表格自适应页宽不右溢，汇总行 30px 且与第一列左对齐
    await page.route('**/api/reports**', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        headers: ['平台','店铺','平台订单号','关联客户','关联 PO','采购日期','实付款','有效采购数量','退货数量','物流状态','料品明细（数量 @ 单价）'],
        summary: ['汇总（54 笔）', null, null, null, null, null, 482272.23, 461, 0, null, null],
        rows: [['淘宝','上海旺华贸易','3316486118019008552','昆山阿普顿自动化系统有限公司','PO02610080014','2026-10-09',16.2,3,0,'韵达快递 435390','德国施耐德防干扰笔记 3 @ 5.40']],
        customers: [],
      }),
    }));
    await page.goto(origin + '/#dashboard');
    await page.locator('.dashboard-reports thead th').first().waitFor({ timeout: 20000 });
    const report = await page.locator('.dashboard-reports .table-scroll').first().evaluate(el => {
      const summary = el.querySelector('tr.report-summary');
      const cell = summary?.querySelector('td');
      const range = document.createRange();
      if (cell) range.selectNodeContents(cell);
      return {
        scroll: el.scrollWidth,
        client: el.clientWidth,
        summaryHeight: summary ? Math.round(summary.getBoundingClientRect().height) : 0,
        textX: cell ? Math.round(range.getBoundingClientRect().x) : 0,
        headX: Math.round(el.querySelector('thead th').getBoundingClientRect().x),
      };
    });
    assert.ok(report.scroll <= report.client + 1, `报表应自适应页宽不右溢：${JSON.stringify(report)}`);
    assert.equal(report.summaryHeight, 30, `汇总行高度应为 30px：${JSON.stringify(report)}`);
    assert.ok(Math.abs(report.textX - report.headX) <= 8, `汇总文字应与第一列左对齐：${JSON.stringify(report)}`);

    // 导入明细：调整过列宽后，列设置隐藏的列仍然保持隐藏（0 宽）
    await page.goto(origin + '/#import');
    const importPanel = page.locator('.import-lines');
    await importPanel.locator('thead th').first().waitFor({ timeout: 20000 });
    const importHandle = importPanel.locator('thead th').first().locator('.col-resize-handle');
    const importBox = await importHandle.boundingBox();
    await page.mouse.move(importBox.x + importBox.width / 2, importBox.y + importBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(importBox.x + importBox.width / 2 + 80, importBox.y + importBox.height / 2, { steps: 6 });
    await page.mouse.up();
    await importPanel.locator('.column-settings > summary').click();
    await importPanel.locator('.column-settings-menu').getByLabel('品牌').uncheck();
    assert.equal(await importPanel.locator('thead th', { hasText: '品牌' }).first().isVisible(), false, '隐藏列保持隐藏');
    await page.reload();
    await importPanel.locator('thead th').first().waitFor({ timeout: 20000 });
    assert.equal(await importPanel.locator('thead th', { hasText: '品牌' }).first().isVisible(), false, '刷新后隐藏列仍隐藏');
    const importWidths = await page.evaluate(async () => (await (await fetch('/api/auth/status')).json()).user.column_settings.widths || {});
    assert.ok(Object.keys(importWidths).some(key => key.startsWith('import:')), '导入明细列宽已保存：' + JSON.stringify(importWidths));

    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 全局明细栏列宽可拖动调整、按账号保存并可双击恢复；截图目录：', temp);
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
