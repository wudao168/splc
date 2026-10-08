const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-inventory-ui-'));
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
    const page = await browser.newPage({ viewport: { width: 1575, height: 892 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(origin + '/#orders');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.orders-list .date-range').waitFor();
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      return payload;
    }, { route, body });
    const state = () => page.evaluate(async () => await (await fetch('/api/state')).json());

    const customer = await post('/customers', { name: '库存客户', contacts: [{ name: '王工', phone: '13800000009' }], addresses: [{ address: '仓库测试路1号', contact: '王工', phone: '13800000009' }] });
    const order = await post('/orders', { customer_id: customer.id, customer: '库存客户', contact: '王工', phone: '13800000009', address: '仓库测试路1号', po: 'PO-INV1',
      lines: [{ name: '化学螺栓', spec: 'M20×260', brand: '东明', quantity: 10, unit: '个', price: 10 }] });
    await post(`/orders/${order.id}/confirm`, {});
    let current = await state();
    const line = current.order_lines.find(item => item.order_id === order.id);
    assert.ok(line.item_id, '新建订单应自动建立料品档案');
    const purchase = await post('/purchases', { platform: '京东', shop: '测试店铺', platform_order: 'JD-INV1', amount: 500,
      lines: [{ order_line_id: line.id, quantity: 10, cost: 500, receive_mode: 'stock' }] });
    current = await state();
    const purchaseLine = current.purchase_lines.find(item => item.purchase_id === purchase.id);
    assert.equal(purchaseLine.mode_label, '入库');
    await post('/receipts', { warehouse_id: current.warehouses[0].id, lines: [{ purchase_line_id: purchaseLine.id, quantity: 10 }] });
    current = await state();
    const item = current.items.find(x => x.id === line.item_id);
    assert.equal(item.on_hand, 10);
    assert.equal(item.reserved, 10, '入库后应自动为关联订单占用库存');

    const auto = current.stock_reservations.find(x => x.status === 'active' && x.order_line_id === line.id);
    await post(`/reservations/${auto.id}/release`, { reason: '改为人工安排占用' });
    await page.goto(origin + '/#orders?order=' + order.id);
    await page.reload();
    await page.getByRole('button', { name: '占用库存' }).click();
    await page.getByLabel('化学螺栓占用数量').fill('6');
    await page.getByRole('button', { name: '确认占用' }).click();
    await page.getByText('库存占用已登记').waitFor();
    current = await state();
    assert.equal(current.items.find(x => x.id === item.id).reserved, 6);

    await page.goto(origin + '/#inventory');
    await page.reload();
    try { await page.locator('.inventory-page').waitFor({ timeout: 15000 }); } catch (e) { throw new Error(`库存页未渲染：${(await page.evaluate(() => document.body.innerText.slice(0, 400)))}；页面错误：${errors.join(' | ')}`); }
    const summary = await page.locator('.inventory-summary').innerText();
    assert.match(summary, /现存量/);
    assert.match(summary, /10/);
    const overviewHeaders = (await page.locator('.inventory-page table').first().locator('thead').innerText()).replace(/\n/g, ' | ');
    if (!/料品名称/.test(overviewHeaders) || !/标准型号/.test(overviewHeaders)) throw new Error(`库存总览应分列显示名称与标准型号：${overviewHeaders}`);
    await page.getByRole('button', { name: '料品档案' }).click();
    await page.getByText('LP000001').first().waitFor();
    await page.getByRole('button', { name: '入库单' }).click();
    await page.getByText('RKD-').first().waitFor();

    await page.goto(origin + '/#orders?order=' + order.id);
    await page.reload();
    await page.getByRole('columnheader', { name: '现存量' }).first().waitFor();
    await page.getByRole('columnheader', { name: '可用库存' }).first().waitFor();
    await page.getByRole('columnheader', { name: '预计可供量' }).first().waitFor();
    await page.getByRole('button', { name: '安排出库' }).click();
    const outboundInput = page.getByLabel('化学螺栓出库数量');
    await outboundInput.fill('6');
    await page.getByRole('button', { name: '确认出库并生成送货单' }).click();
    await page.waitForTimeout(3000);
    const notice = await page.locator('.toast').count() ? await page.locator('.toast').first().innerText() : '(无提示)';
    if (!/出库已办理/.test(notice)) {
      const dump = await page.evaluate(() => ({ hash: location.hash, text: document.body.innerText.slice(-1500), outbounds: document.querySelectorAll('.inventory-page').length }));
      throw new Error(`出库失败：${notice}；页面错误：${errors.join(' | ')}；现场：${JSON.stringify(dump)}`);
    }
    current = await state();
    assert.equal(current.stock_outbounds.length, 1);
    const delivery = current.deliveries[0];
    assert.match(delivery.number, /^SHD-PO-INV1-/);
    const outbound = current.stock_outbounds[0];
    assert.equal(outbound.delivery_id, delivery.id);
    const updated = current.order_lines.find(x => x.id === line.id);
    assert.equal(updated.stock_on_hand, 4);
    assert.equal(updated.stock_cost_cents, 30000, '出库成本应计入订单');

    await page.goto(origin + '/#inventory');
    await page.reload();
    await page.getByRole('button', { name: '出库单' }).click();
    await page.getByText(outbound.number).first().waitFor();
    await page.getByRole('button', { name: '库存流水' }).click();
    await page.getByText('销售出库').first().waitFor();

    await page.goto(origin + '/#products');
    await page.reload();
    await page.getByRole('button', { name: '新增料品' }).click();
    if (await page.getByLabel('采购单位', { exact: true }).count() || await page.getByLabel('包装换算系数', { exact: true }).count()) {
      throw new Error('料品档案不应再有“采购单位/包装换算系数”字段');
    }
    await page.getByRole('button', { name: '关闭' }).click();
    const productToolbar = await page.locator('.products-page .toolbar').innerText();
    if (!/显示已停用料品/.test(productToolbar)) throw new Error('“显示已停用料品”应放在搜索栏右侧的工具条里');
    const productFootnotes = await page.locator('.products-page .footnote').count();
    if (productFootnotes) throw new Error('产品库底部的说明文字应已删除');
    await page.getByRole('button', { name: '新增料品' }).click();
    await page.getByLabel('料品名称 *').fill('备货螺母');
    await page.getByLabel('标准型号 *').fill('M8');
    await page.getByLabel('库存单位 *').fill('个');
    await page.getByRole('button', { name: '保存料品' }).click();
    await page.getByText('料品档案已新增').waitFor();
    current = await state();
    const newItem = current.items.find(x => x.name === '备货螺母');
    assert.ok(newItem, '产品库应能新增料品');
    assert.match(newItem.code, /^LP\d{6}$/);

    await page.goto(origin + '/#purchases');
    await page.reload();
    await page.getByRole('button', { name: '登记采购' }).click();
    await page.getByLabel('供应商 *').fill('备货店铺');
    await page.getByLabel('显示订单号 *').fill('JD-STOCK-1');
    await page.getByLabel('实付款（含运费、已扣优惠）*').fill('90');
    await page.getByRole('button', { name: '产品库选择', exact: true }).click();
    await page.getByLabel(`选择料品 ${newItem.code}`).check();
    await page.getByRole('button', { name: '确认选择（1）' }).click();
    await page.getByLabel('备货螺母对应需求数量').fill('3');
    await page.getByLabel('备货螺母实际包装数量').fill('3');
    await page.getByLabel('备货螺母备货成本').fill('90');
    await page.getByRole('button', { name: '保存采购记录' }).click();
    await page.getByText('采购已保存').waitFor();
    current = await state();
    const stockLine = current.purchase_lines.find(x => x.purchase_id === current.purchases.find(p => p.platform_order === 'JD-STOCK-1').id);
    assert.equal(stockLine.order_line_id, null);
    assert.equal(stockLine.item_id, newItem.id);
    assert.equal(stockLine.receive_mode, 'stock');
    assert.equal(stockLine.quantity, 3);
    assert.equal(stockLine.cost_cents, 9000);
    assert.equal(current.items.find(x => x.id === newItem.id).incoming_unallocated, 3);

    await page.goto(origin + '/#inventory');
    await page.reload();
    await page.getByRole('button', { name: '入库单' }).click();
    await page.getByRole('button', { name: '登记入库' }).click();
    await page.getByLabel(`选择入库明细 ${stockLine.id}`).check();
    await page.getByRole('button', { name: '确认入库' }).click();
    await page.getByText('入库已登记，库存与订单占用已更新').waitFor();
    current = await state();
    assert.equal(current.items.find(x => x.id === newItem.id).on_hand, 3);

    await page.goto(origin + '/#purchases');
    await page.reload();
    await page.getByRole('row', { name: /JD-STOCK-1/ }).getByRole('button', { name: '查看明细' }).click();
    await page.getByRole('dialog').waitFor();
    const detailText = await page.getByRole('dialog').innerText();
    if (!/备货料品 LP\d{6} 备货螺母/.test(detailText)) throw new Error(`采购明细未显示备货料品：${detailText.slice(0, 600)}`);
    await page.getByRole('button', { name: '关闭' }).click();

    await page.goto(origin + '/#import');
    await page.reload();
    await page.getByLabel('第1行料品名称').fill('化学螺栓');
    await page.getByLabel('第1行料品规格').fill('M20×260');
    await page.getByLabel('第1行数量').fill('1');
    await page.locator('.import-lines').getByRole('columnheader', { name: '现存量' }).waitFor();
    await page.locator('.import-lines').getByRole('columnheader', { name: '可用库存' }).waitFor();
    const onHandCell = page.getByTitle('按型号匹配料品档案的仓库现存量').first();
    await onHandCell.waitFor();
    const onHandText = (await onHandCell.innerText()).trim();
    if (onHandText !== '4') throw new Error(`料品明细现存量应为 4，实际 ${onHandText}`);

    await page.goto(origin + '/#inventory');
    await page.reload();
    await page.getByRole('button', { name: '仓库', exact: true }).click();
    await page.getByRole('row', { name: /主仓/ }).getByRole('button', { name: '编辑' }).click();
    await page.getByLabel('仓库名称 *').fill('主仓库');
    await page.getByLabel('存放位置').fill('A1');
    await page.getByRole('button', { name: '保存修改' }).click();
    await page.getByText('仓库已更新').waitFor();
    current = await state();
    assert.equal(current.warehouses[0].name, '主仓库');
    await page.getByRole('button', { name: '改为新增仓库' }).click();
    await page.getByLabel('仓库名称 *').fill('成都仓库');
    await page.getByLabel('存放位置').fill('B1');
    await page.getByLabel('设为默认仓库：入库、出库、库存占用未指定时默认使用').check();
    await page.getByRole('button', { name: '新增仓库' }).click();
    await page.getByText('仓库已新增').waitFor();
    current = await state();
    assert.equal(current.warehouses[0].name, '成都仓库');
    assert.equal(current.warehouses[0].is_default, 1);
    await page.getByRole('row', { name: /成都仓库/ }).getByRole('button', { name: '停用' }).click();
    await page.getByText('默认仓库不能停用').waitFor();
    await page.getByLabel('仓库名称 *').fill('临时仓库');
    await page.getByRole('button', { name: '新增仓库' }).click();
    await page.getByText('仓库已新增').waitFor();
    await page.getByRole('row', { name: /临时仓库/ }).getByRole('button', { name: '删除' }).click();
    await page.getByText('仓库已删除').waitFor();
    current = await state();
    assert.equal(current.warehouses.some(warehouse => warehouse.name === '临时仓库'), false);

    const multi = await post('/orders', { customer_id: customer.id, customer: '库存客户', contact: '王工', phone: '13800000009', address: '仓库测试路1号', po: 'PO-INV2',
      lines: [{ name: '化学螺栓', spec: 'M20×260', brand: '东明', quantity: 4, unit: '个', price: 10 }, { name: '备货螺母', spec: 'M8', quantity: 2, unit: '个', price: 5 }] });
    await post(`/orders/${multi.id}/confirm`, {});
    current = await state();
    const multiLines = current.order_lines.filter(line => line.order_id === multi.id);
    await post('/purchases', { platform: '京东', shop: '多品店铺', platform_order: 'JD-MULTI', amount: 60,
      lines: multiLines.map(line => ({ order_line_id: line.id, quantity: line.quantity, cost: 30, receive_mode: 'direct' })) });
    await page.goto(origin + '/#purchases');
    await page.reload();
    const multiRow = page.getByRole('row').filter({ hasText: 'JD-MULTI' });
    const singleRow = page.getByRole('row').filter({ hasText: 'JD-STOCK-1' });
    if (!/备货螺母/.test(await singleRow.innerText())) throw new Error('单项采购应在料品/规格列直接显示料品');
    if (await page.locator('.purchase-item-count').count()) throw new Error('“商品”列应已移除');
    await page.screenshot({ path: 'E:/SPLC/.data/layout-check/purchase-list.png' });
    const multiText = await multiRow.innerText();
    if (!/化学螺栓/.test(multiText) || !/M20×260/.test(multiText)) throw new Error(`多项采购应显示首项料品与规格：${multiText.replace(/\n/g, ' | ')}`);
    await multiRow.getByRole('button', { name: /化学螺栓/ }).hover();
    await page.getByRole('tooltip').waitFor();
    const hoverText = await page.getByRole('tooltip').innerText();
    if (!/化学螺栓/.test(hoverText) || !/备货螺母/.test(hoverText)) throw new Error(`悬停预览应列出全部料品：${hoverText.replace(/\n/g, ' | ')}`);
    await page.screenshot({ path: 'E:/SPLC/.data/layout-check/purchase-hover.png' });
    await multiRow.getByRole('button', { name: /化学螺栓/ }).click();
    await page.getByRole('dialog', { name: /料品预览/ }).waitFor();
    const previewText = await page.getByRole('dialog').innerText();
    if (!/化学螺栓/.test(previewText) || !/备货螺母/.test(previewText)) throw new Error(`预览窗应列出两项料品：${previewText}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'E:/SPLC/.data/layout-check/purchase-preview.png' });
    await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();

    // 列调整：物流列紧跟料品/规格、商品列移除；列设置按账号保存
    await page.goto(origin + '/#purchases');
    await page.reload();
    await page.locator('.purchases-list table').waitFor();
    const purchaseHeaders = await page.locator('.purchases-list th:visible').allTextContents();
    if (purchaseHeaders[purchaseHeaders.indexOf('料品 / 规格') + 1] !== '物流') throw new Error(`物流列应紧跟料品/规格：${purchaseHeaders.join(' | ')}`);
    if (purchaseHeaders.some(text => text === '商品')) throw new Error('“商品”列应已移除');
    await page.locator('.purchases-list .column-settings > summary').click();
    await page.screenshot({ path: 'E:/SPLC/.data/layout-check/column-settings.png' });
    await page.locator('.purchases-list .column-settings-menu').getByLabel('物流', { exact: true }).uncheck();
    await page.waitForTimeout(300);
    const hiddenHeaders = await page.locator('.purchases-list th:visible').allTextContents();
    if (hiddenHeaders.includes('物流')) throw new Error(`取消勾选后应隐藏物流列；属性=${await page.locator('.purchases-list').getAttribute('data-hidden-columns')}；表头=${hiddenHeaders.join('|')}`);
    await page.reload();
    await page.locator('.purchases-list table').waitFor();
    const afterReload = await page.locator('.purchases-list th:visible').allTextContents();
    if (afterReload.includes('物流')) throw new Error('刷新后应保持上次的列设置');
    const authStatus = await page.evaluate(async () => await (await fetch('/api/auth/status')).json());
    if (!(authStatus.user?.column_settings?.purchases || []).includes('logistics')) throw new Error('列设置应保存到账号：' + JSON.stringify(authStatus.user?.column_settings));
    await page.locator('.purchases-list .column-settings > summary').click();
    await page.locator('.purchases-list .column-settings-menu').getByLabel('物流', { exact: true }).check();

    await page.goto(origin + '/#orders');
    await page.reload();
    await page.locator('.orders-list .column-settings > summary').click();
    await page.locator('.orders-list .column-settings-menu').getByLabel('订单备注', { exact: true }).uncheck();
    await page.waitForTimeout(300);
    if ((await page.locator('.orders-list th:visible').allTextContents()).includes('订单备注')) throw new Error(`客户订单列设置应能隐藏“订单备注”；属性=${await page.locator('.orders-list').getAttribute('data-hidden-columns')}；表头=${(await page.locator('.orders-list th:visible').allTextContents()).join('|')}`);
    await page.goto(origin + '/#products');
    await page.reload();
    await page.locator('.products-page .column-settings > summary').click();
    await page.locator('.products-page .column-settings-menu').getByLabel('品牌', { exact: true }).uncheck();
    await page.waitForTimeout(300);
    if ((await page.locator('.products-page th:visible').allTextContents()).includes('品牌')) throw new Error('产品库列设置应能隐藏“品牌”');
    assert.deepEqual(errors, []);
    console.log('inventory ui ok');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
