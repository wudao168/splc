const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-tabs-'));
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
    const page = await browser.newPage({ viewport: { width: 1575, height: 892 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
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
    const customer = await post('/customers', { name: '页签样式客户', contacts: [{ name: '张工', phone: '13800000009' }], addresses: [{ address: '测试地址9号', contact: '张工', phone: '13800000009' }] });
    const order = await post('/orders', { customer_id: customer.id, customer: '页签样式客户', contact: '张工', phone: '13800000009', address: '测试地址9号', po: 'PO-TABS-1', lines: [{ name: '甲', quantity: 1, unit: '个', price: 10 }] });
    await post(`/orders/${order.id}/confirm`, {});
    await page.reload();
    await page.locator('.orders-list .date-range').waitFor();

    const checkTabs = async (scope, expected) => {
      const buttons = scope.locator('.tabs > button');
      assert.equal(await buttons.count(), expected, `页签数量应为 ${expected}`);
      for (let index = 0; index < expected; index += 1) {
        assert.equal(await buttons.nth(index).locator('svg').count(), 1, `第 ${index + 1} 个页签应有图标`);
      }
      const active = scope.locator('.tabs > button.active');
      assert.equal(await active.count(), 1, '应有且仅有一个选中页签');
      const style = await active.evaluate(el => {
        const computed = getComputedStyle(el);
        const probe = document.createElement('span');
        probe.style.color = 'var(--teal)';
        document.body.appendChild(probe);
        const themeColor = getComputedStyle(probe).color;
        probe.remove();
        return [computed.borderBottomWidth, computed.borderBottomColor, computed.display, computed.alignItems, computed.color, themeColor];
      });
      assert.equal(style[0], '3px', '选中页签应有 3px 底部标线');
      assert.equal(style[1], style[5], '选中页签标线应使用主题色');
      assert.equal(style[4], style[5], '选中页签文字应使用主题色');
      assert.ok(['flex', 'inline-flex'].includes(style[2]), `页签应为图标 + 文字排列（实际 ${style[2]}）`);
    };

    const routes = [['#orders', 2], ['#customers', 2], ['#inventory', 5], ['#purchases', 3], ['#sales-invoices', 2], ['#settings', 6]];
    for (const [route, expected] of routes) {
      await page.goto(origin + '/' + route);
      await page.locator('.tabs > button').first().waitFor();
      await checkTabs(page.locator('main'), expected);
      await page.locator('main .tabs').first().screenshot({ path: path.join(temp, `${route.slice(1)}.png`) });
    }

    await page.goto(origin + '/#orders');
    await page.locator('.orders-list .date-range').waitFor();
    await page.locator('.orders-list tbody tr').filter({ hasText: 'PO-TABS-1' }).getByRole('button', { name: '查看', exact: true }).click();
    const modal = page.locator('.modal');
    await modal.locator('.lifecycle .tabs').waitFor();
    await checkTabs(modal, 2);
    await modal.locator('.lifecycle .tabs').screenshot({ path: path.join(temp, 'order-lifecycle.png') });
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await modal.waitFor({ state: 'detached' });
    const activeTabColor = () => page.locator('main .tabs > button.active').first().evaluate(el => getComputedStyle(el).color);
    for (const [label, expected] of [['青蓝平衡', 'rgb(29, 78, 216)'], ['暖橙活力', 'rgb(180, 83, 9)'], ['石墨青绿', 'rgb(8, 117, 111)']]) {
      await page.locator('.theme-picker summary').click();
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(150);
      assert.equal(await activeTabColor(), expected, `主题「${label}」下页签应使用对应主题色`);
    }
    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 全站页签均为图标 + 文字、蓝色底部标线；截图：', temp);
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
