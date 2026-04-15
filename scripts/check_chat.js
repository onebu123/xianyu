const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'screenshots', 'audit');
const BASE = 'http://localhost:5173';

const PAGES = [
  { name: '01_dashboard', path: '/dashboard' },
  { name: '02_stores', path: '/stores' },
  { name: '03_products', path: '/products' },
  { name: '04_orders', path: '/orders' },
  { name: '05_after_sale', path: '/after-sale' },
  { name: '06_reports', path: '/reports' },
  { name: '07_ai_service', path: '/workspace/ai-service' },
  { name: '08_ai_bargain', path: '/workspace/ai-bargain' },
  { name: '09_faka', path: '/workspace/faka' },
  { name: '10_card_types', path: '/workspace/card-types' },
  { name: '11_card_delivery', path: '/workspace/card-delivery' },
  { name: '12_limited_purchase', path: '/workspace/limited-purchase' },
  { name: '13_fish_coin', path: '/workspace/fish-coin' },
  { name: '14_move', path: '/workspace/move' },
  { name: '15_school', path: '/workspace/school' },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();

  // 登录
  console.log('登录中...');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  try { await page.fill('#username', 'admin'); } catch {}
  try { await page.fill('#password', 'SaleCompass@20260312'); } catch {}
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  for (const p of PAGES) {
    console.log(`截图: ${p.name} (${p.path})`);
    await page.goto(`${BASE}${p.path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, `${p.name}.png`), fullPage: false });
  }

  await browser.close();
  console.log(`\n全部完成！共 ${PAGES.length} 张截图，保存于 ${OUT}`);
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
