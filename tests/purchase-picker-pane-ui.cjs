const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-picker-pane-'));
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
    await page.goto(origin + '/#purchases');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '平台采购', exact: true }).waitFor();
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      return payload;
    }, { route, body });
    const customer = await post('/customers', { name: '抽屉客户', contacts: [{ name: '王工', phone: '13800000021' }], addresses: [{ address: '测试地址21号', contact: '王工', phone: '13800000021' }] });
    const order = await post('/orders', { customer_id: customer.id, customer: '抽屉客户', contact: '王工', phone: '13800000021', address: '测试地址21号', po: 'PO-PANE-1', lines: Array.from({ length: 20 }, (_, index) => ({ name: `料品${index + 1}号比较长的名称`, spec: `A-${index + 1}`, quantity: index + 1, unit: '个', price: 10 })) });
    await post(`/orders/${order.id}/confirm`, {});
    await post('/items', { name: '备货料品', spec: 'B-1', unit: '个' });
    await page.reload();
    await page.getByRole('button', { name: '平台采购', exact: true }).waitFor();

    const checkPane = async (label, modal) => {
      const pane = modal.locator('.purchase-line-picker-backdrop');
      await pane.waitFor();
      await page.waitForTimeout(240);
      const info = await modal.evaluate(el => {
        const pane = el.querySelector('.purchase-line-picker-backdrop');
        const form = el.querySelector('.purchase-registration-form, .sales-invoice-form');
        const picker = el.querySelector('.purchase-line-picker');
        const paneRect = pane.getBoundingClientRect(), formRect = form.getBoundingClientRect(), modalRect = el.getBoundingClientRect();
        return {
          panePosition: getComputedStyle(pane).position,
          pickerAnimation: getComputedStyle(picker).animationName,
          paneAnimation: getComputedStyle(pane).animationName,
          pickerScrollLeft: picker.scrollLeft,
          actionsInHead: !!el.querySelector('.purchase-line-picker-head > .purchase-line-picker-actions'),
          paneRect: { top: paneRect.top, right: paneRect.right, left: paneRect.left, height: paneRect.height, width: paneRect.width },
          formRect: { left: formRect.left, top: formRect.top, height: formRect.height, width: formRect.width },
          modalRect: { left: modalRect.left, top: modalRect.top, width: modalRect.width, height: modalRect.height },
        };
      });
      assert.equal(info.panePosition, 'absolute', `${label}：选择器应吸附在登记抽屉左侧`);
      assert.notEqual(info.pickerAnimation, 'drawer-in', `${label}：不应使用旧的弹入动画`);
      assert.ok(info.actionsInHead, `${label}：取消/确认选择应与标题同处右上角`);
      assert.ok(Math.abs(info.paneRect.top - info.modalRect.top) <= 1, `${label}：选择器顶部应与抽屉页头平齐`);
      assert.ok(Math.abs(info.paneRect.right - info.modalRect.left) <= 2, `${label}：选择器应紧贴登记抽屉左侧（${info.paneRect.right} / ${info.modalRect.left}）`);
      assert.equal(info.pickerScrollLeft, 0, `${label}：左侧内容不应被横向裁切（scrollLeft=${info.pickerScrollLeft}）`);
      assert.ok(Math.abs((info.paneRect.top + info.paneRect.height) - (info.modalRect.top + info.modalRect.height)) <= 2, `${label}：选择器应与抽屉底部对齐`);
      return info;
    };
    const formWidthOf = modal => modal.locator('.purchase-registration-form, .sales-invoice-form').evaluate(el => {
      const style = getComputedStyle(el);
      return Math.round(el.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    });
    const formRectOf = modal => modal.locator('.purchase-registration-form, .sales-invoice-form').evaluate(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const left = rect.left + parseFloat(style.paddingLeft), top = rect.top + parseFloat(style.paddingTop);
      return {
        left: Math.round(left), top: Math.round(top),
        width: Math.round(rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        height: Math.round(rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)),
      };
    });
    const drawerWidthOf = modal => modal.evaluate(el => Math.round(el.getBoundingClientRect().width));
    const centerY = locator => locator.evaluate(el => { const rect = el.getBoundingClientRect(); return Math.round((rect.top + rect.bottom) / 2); });
    const leftOf = locator => locator.evaluate(el => Math.round(el.getBoundingClientRect().left));
    const rightOf = locator => locator.evaluate(el => Math.round(el.getBoundingClientRect().right));

    await page.getByRole('button', { name: '平台采购', exact: true }).click();
    const platform = page.getByRole('dialog', { name: '登记平台采购' });
    await page.waitForTimeout(400);
    assert.equal(await drawerWidthOf(platform), 800, '登记抽屉应固定 800px');
    const platformFormWidth = await formWidthOf(platform);
    const platformFormRect = await formRectOf(platform);
    const platformTitleLeft = await leftOf(platform.locator('.modal-title h2'));
    const linkButton = platform.getByRole('button', { name: '关联料品', exact: true });
    const saveButton = platform.getByRole('button', { name: '保存采购记录', exact: true });
    assert.ok((await leftOf(saveButton)) - (await rightOf(linkButton)) <= 14, '保存按钮应靠近关联料品');
    await page.screenshot({ path: path.join(temp, 'platform-closed.png') });
    const platformHeaders = await platform.locator('.purchase-registration-form thead th').allInnerTexts();
    for (const title of ['需求数量', '单位', '规格']) assert.ok(platformHeaders.some(text => text.trim() === title), `平台采购表头应有「${title}」`);
    for (const old of ['对应需求数量', '采购单位', '采购规格']) assert.ok(!platformHeaders.some(text => text.trim() === old), `平台采购表头不应再有「${old}」`);
    await linkButton.click();
    const platformPane = await checkPane('platform', platform);
    await page.waitForTimeout(300);
    assert.equal(await platform.locator('.purchase-line-picker-head .purchase-line-picker-actions button').count(), 2, '选择器顶部只保留取消/确认选择');
    const actionSize = await platform.getByRole('button', { name: /确认选择/ }).evaluate(el => { const rect = el.getBoundingClientRect(); return { width: Math.round(rect.width), height: Math.round(rect.height) }; });
    assert.deepEqual(actionSize, { width: 100, height: 32 }, `选择器按钮尺寸应为 100×32（实际 ${actionSize.width}×${actionSize.height}）`);
    const confirmCenter = await centerY(platform.getByRole('button', { name: /确认选择/ }));
    const linkCenter = await centerY(linkButton);
    assert.ok(Math.abs(confirmCenter - linkCenter) <= 2, `选择器按钮应与关联料品上下对齐（${confirmCenter} / ${linkCenter}）`);
    assert.equal(await leftOf(platform.locator('.modal-title h2')), platformTitleLeft, '展开时页头标题不应移动');
    assert.equal(await drawerWidthOf(platform), 800, '展开选择器时登记抽屉宽度不变');
    assert.equal(await formWidthOf(platform), platformFormWidth, '展开选择器后登记区宽度不变');
    assert.deepEqual(await formRectOf(platform), platformFormRect, '展开左侧选择器时登记区不应移动');
    assert.equal(await platform.locator('.purchase-line-picker').evaluate(el => el.scrollLeft), 0, '展开完成后左侧内容不应被裁切');
    await platform.locator('.purchase-line-picker tbody tr').first().getByRole('button', { name: '选择', exact: true }).click();
    const detailTable = platform.locator('.purchase-registration-form > .table-scroll');
    await detailTable.locator('tbody tr').first().waitFor();
    const addedCells = await detailTable.locator('tbody tr').first().locator('td').allInnerTexts();
    assert.ok(addedCells[0].includes('料品20号') && !addedCells[0].includes('PO-PANE-1'), `料品列不应显示 PO（实际 ${addedCells[0]}）`);
    assert.ok(addedCells[1].includes('PO-PANE-1'), `客户 PO 列应显示 PO（实际 ${addedCells[1]}）`);
    const tableFit = await detailTable.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(tableFit.scroll <= tableFit.client + 2, `明细表不应横向溢出（${tableFit.scroll}/${tableFit.client}）`);
    await platform.locator('.purchase-line-picker tbody tr').first().getByRole('button', { name: '取消', exact: true }).click();
    await detailTable.locator('tbody tr').first().waitFor({ state: 'detached' });
    await platform.locator('.purchase-line-picker tbody tr').first().getByRole('button', { name: '选择', exact: true }).click();
    await detailTable.locator('tbody tr').first().waitFor();
    await page.screenshot({ path: path.join(temp, 'platform.png') });
    await linkButton.click();
    await page.waitForTimeout(60);
    assert.equal(await platform.locator('.purchase-line-picker-backdrop.closing').count(), 1, '收起时左侧面板应播放消失动画');
    assert.deepEqual(await formRectOf(platform), platformFormRect, '收起动画期间登记区不应移动');
    await platform.locator('.purchase-line-picker-backdrop').waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    assert.equal(await leftOf(platform.locator('.modal-title h2')), platformTitleLeft, '收起时页头标题不应移动');
    assert.equal(await drawerWidthOf(platform), 800, '二次点击关联料品应收起选择器');
    assert.equal(await formWidthOf(platform), platformFormWidth, '收起后登记区宽度不变');
    assert.deepEqual(await formRectOf(platform), platformFormRect, '收起左侧选择器时登记区不应移动');
    await platform.getByRole('button', { name: '关闭', exact: true }).click();

    await page.getByRole('button', { name: '常规采购', exact: true }).click();
    const regular = page.getByRole('dialog', { name: '登记常规采购' });
    assert.equal(await drawerWidthOf(regular), 800, '常规采购抽屉应固定 800px');
    const regularFormWidth = await formWidthOf(regular);
    const regularHeaders = await regular.locator('.purchase-registration-form thead th').allInnerTexts();
    for (const title of ['单位', '规格']) assert.ok(regularHeaders.some(text => text.trim() === title), `常规采购表头应有「${title}」`);
    await regular.getByRole('button', { name: '产品库选择', exact: true }).click();
    await checkPane('regular', regular);
    assert.equal(await formWidthOf(regular), regularFormWidth, '展开产品库后常规采购登记区宽度不变');
    await regular.locator('.purchase-line-picker tbody tr').first().getByRole('button', { name: '加入', exact: true }).click();
    await page.waitForTimeout(150);
    assert.equal(await regular.locator('.purchase-line-picker-backdrop').count(), 1, '点击加入后抽屉不应折叠');
    assert.equal(await regular.locator('.purchase-line-picker tbody tr').first().getByRole('button', { name: '取消', exact: true }).count(), 1, '加入后应显示取消按钮');
    await page.screenshot({ path: path.join(temp, 'regular.png') });
    await regular.getByRole('button', { name: '产品库选择', exact: true }).click();
    await regular.locator('.purchase-line-picker-backdrop').waitFor({ state: 'detached' });
    await regular.getByRole('button', { name: '关闭', exact: true }).click();

    await page.goto(origin + '/#sales-invoices');
    await page.getByRole('button', { name: '录入发票', exact: true }).click();
    const invoice = page.getByRole('dialog', { name: '录入销售发票' });
    await invoice.getByRole('combobox', { name: '客户 *' }).click();
    await invoice.getByRole('option', { name: /抽屉客户/ }).click();
    await invoice.getByRole('button', { name: '关联 PO', exact: true }).click();
    await checkPane('invoice', invoice);
    await invoice.getByRole('button', { name: '关联 PO', exact: true }).click();
    await invoice.locator('.purchase-line-picker-backdrop').waitFor({ state: 'detached' });
    await invoice.getByRole('button', { name: '关闭', exact: true }).click();

    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 关联料品/产品库选择改为从登记抽屉左侧就地展开并可手动收起；截图：', temp);
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
