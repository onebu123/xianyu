import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { resolvePostgresTarget, sleep } from './postgres-smoke-runtime.mjs';

const { Pool } = pg;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(repoRoot, 'server', 'dist', 'server.js');

function ensureExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`);
  }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: text ? JSON.parse(text) : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(baseUrl) {
  let lastError = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetchJson(`${baseUrl}/api/health`, { timeoutMs: 3000 });
      if (response.status === 200 && response.json?.status === 'ok') {
        return response.json;
      }
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw lastError ?? new Error('Health check timed out.');
}

function readPrometheusGauge(text, metricName) {
  const pattern = new RegExp(`^${metricName}\\s+(-?\\d+(?:\\.\\d+)?)$`, 'm');
  const match = text.match(pattern);
  if (!match) {
    throw new Error(`Missing Prometheus metric: ${metricName}`);
  }
  return Number(match[1]);
}

function hasTenantAdapterCapabilityWarning(text, capability) {
  return (
    text.includes('"event":"tenant_business_read_adapter_capability_missing"') &&
    text.includes(`"capability":"${capability}"`)
  );
}

function normalizeCipherKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptSecretForSmoke(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', normalizeCipherKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

function signOpenPlatformRequest({ appKey, secret, timestamp, method, routePath }) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${appKey}.${timestamp}.${method.toUpperCase()}.${routePath}`)
    .digest('hex');
}

function buildSignedOpenPlatformHeaders({ appKey, secret, method, routePath }) {
  const timestamp = String(Date.now());
  return {
    'x-open-app-key': appKey,
    'x-open-timestamp': timestamp,
    'x-open-signature': signOpenPlatformRequest({
      appKey,
      secret,
      timestamp,
      method,
      routePath,
    }),
  };
}

async function shutdown(childProcess) {
  if (childProcess.exitCode !== null) {
    return;
  }

  childProcess.kill('SIGTERM');
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (childProcess.exitCode === null) {
        childProcess.kill('SIGKILL');
      }
      resolve();
    }, 5000);
    childProcess.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

ensureExists(serverEntry);

const target = await resolvePostgresTarget({
  envUrlNames: ['APP_TENANT_BUSINESS_POSTGRES_URL_TEMPLATE', 'SMOKE_POSTGRES_URL'],
  portBase: 57432,
  databaseName: 'sale_compass',
  dataDirPrefix: 'sale-compass-tenant-business-pglite-',
});

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-compass-saas-tenant-pg-'));
const port = 5000 + Math.floor(Math.random() * 200);
const adminPassword = 'SmokePlatform@20260420';
const serverLogs = [];

const childProcess = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_DEPLOYMENT_MODE: 'saas',
    APP_RUNTIME_MODE: 'staging',
    APP_ENABLE_DEMO_DATA: 'false',
    APP_DATA_ROOT: smokeRoot,
    APP_DB_PATH: path.join(smokeRoot, 'private-app.db'),
    APP_CONTROL_PLANE_DB_PATH: path.join(smokeRoot, 'control-plane.db'),
    APP_TENANT_DB_ROOT: path.join(smokeRoot, 'tenants'),
    APP_LOG_ROOT: path.join(smokeRoot, 'logs'),
    APP_BACKUP_ROOT: path.join(smokeRoot, 'backups'),
    APP_UPLOAD_ROOT: path.join(smokeRoot, 'uploads'),
    APP_TENANT_BUSINESS_DB_ENGINE: 'postgres',
    APP_TENANT_BUSINESS_POSTGRES_URL_TEMPLATE: target.connectionString,
    JWT_SECRET: 'saas-tenant-pg-smoke-jwt-secret-20260420',
    APP_CONFIG_CIPHER_SECRET: 'saas-tenant-pg-smoke-config-secret-20260420',
    APP_INIT_ADMIN_USERNAME: 'platform-admin',
    APP_INIT_ADMIN_PASSWORD: adminPassword,
    APP_INIT_ADMIN_DISPLAY_NAME: 'Tenant PG Smoke Admin',
    APP_METRICS_ENABLED: 'true',
    APP_METRICS_TOKEN: 'saas-tenant-pg-metrics-token-20260420',
    APP_BACKGROUND_JOBS_MODE: 'worker',
    APP_LOG_LEVEL: 'info',
    APP_REQUEST_LOGGING_ENABLED: 'true',
    APP_TRUST_PROXY: 'false',
    APP_STRICT_TENANT_PG_WRITES: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

childProcess.stdout.on('data', (chunk) => {
  serverLogs.push(String(chunk));
});
childProcess.stderr.on('data', (chunk) => {
  serverLogs.push(String(chunk));
});

const baseUrl = `http://127.0.0.1:${port}`;

try {
  await waitForHealth(baseUrl);

  const loginResponse = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    timeoutMs: 5000,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: 'platform-admin',
      password: adminPassword,
    }),
  });
  if (loginResponse.status !== 200 || loginResponse.json?.scope !== 'platform' || !loginResponse.json?.token) {
    throw new Error(`Platform login failed: ${loginResponse.text}`);
  }

  const platformHeaders = {
    authorization: `Bearer ${loginResponse.json.token}`,
    'content-type': 'application/json',
  };

  const tenantCreateResponse = await fetchJson(`${baseUrl}/api/platform/tenants`, {
    method: 'POST',
    headers: platformHeaders,
    body: JSON.stringify({
      tenantKey: 'tenant-pg-smoke',
      tenantName: 'Tenant PG Smoke',
      displayName: 'Tenant PG Smoke',
    }),
  });
  if (tenantCreateResponse.status !== 200 || !tenantCreateResponse.json?.tenant?.id) {
    throw new Error(`Tenant create failed: ${tenantCreateResponse.text}`);
  }
  const tenantId = tenantCreateResponse.json.tenant.id;

  const tenantSelectResponse = await fetchJson(`${baseUrl}/api/auth/select-tenant`, {
    method: 'POST',
    headers: platformHeaders,
    body: JSON.stringify({
      tenantId,
    }),
  });
  if (tenantSelectResponse.status !== 200 || tenantSelectResponse.json?.scope !== 'tenant') {
    throw new Error(`Tenant select failed: ${tenantSelectResponse.text}`);
  }

  const tenantHeaders = {
    authorization: `Bearer ${tenantSelectResponse.json.token}`,
  };
  const tenantJsonHeaders = {
    ...tenantHeaders,
    'content-type': 'application/json',
  };

  const optionsResponse = await fetchJson(`${baseUrl}/api/options`, {
    headers: tenantHeaders,
  });
  if (optionsResponse.status !== 200) {
    throw new Error(`Tenant filter options failed: ${optionsResponse.text}`);
  }

  const dashboardResponse = await fetchJson(`${baseUrl}/api/dashboard?preset=last30Days`, {
    headers: tenantHeaders,
  });
  if (dashboardResponse.status !== 200) {
    throw new Error(`Tenant dashboard failed: ${dashboardResponse.text}`);
  }

  const ordersOverviewResponse = await fetchJson(`${baseUrl}/api/orders/overview?preset=last30Days`, {
    headers: tenantHeaders,
  });
  if (ordersOverviewResponse.status !== 200) {
    throw new Error(`Tenant orders overview failed: ${ordersOverviewResponse.text}`);
  }

  const pool = new Pool({
    connectionString: target.connectionString,
    max: 2,
  });

  try {
    const tableCheck = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users', 'orders', 'products', 'managed_stores')
    `);
    if ((tableCheck.rows[0]?.count ?? 0) < 4) {
      throw new Error('Provisioned PostgreSQL tenant database is missing required tables.');
    }

    const usersCount = await pool.query('SELECT COUNT(*)::int AS count FROM public.users');
    const tenantUserIdResult = await pool.query(
      `SELECT id FROM public.users ORDER BY id ASC LIMIT 1`,
    );
    const tenantUserId = Number(tenantUserIdResult.rows[0]?.id ?? 1);
    const productsCount = await pool.query('SELECT COUNT(*)::int AS count FROM public.products');
    const nextIds = await pool.query(`
      SELECT
        COALESCE((SELECT MAX(id) FROM public.stores), 0) + 1 AS "nextStoreId",
        COALESCE((SELECT MAX(id) FROM public.products), 0) + 1 AS "nextProductId",
        COALESCE((SELECT MAX(id) FROM public.customers), 0) + 1 AS "nextCustomerId",
        COALESCE((SELECT MAX(id) FROM public.orders), 0) + 1 AS "nextOrderId",
        COALESCE((SELECT MAX(id) FROM public.order_events), 0) + 1 AS "nextOrderEventId",
        COALESCE((SELECT MAX(id) FROM public.after_sale_cases), 0) + 1 AS "nextAfterSaleCaseId",
        COALESCE((SELECT MAX(id) FROM public.after_sale_refunds), 0) + 1 AS "nextAfterSaleRefundId",
        COALESCE((SELECT MAX(id) FROM public.after_sale_records), 0) + 1 AS "nextAfterSaleRecordId",
        COALESCE((SELECT MAX(id) FROM public.after_sale_reminders), 0) + 1 AS "nextAfterSaleReminderId"
    `);
    const markerStoreId = Number(nextIds.rows[0]?.nextStoreId ?? 1);
    const markerProductId = Number(nextIds.rows[0]?.nextProductId ?? 1);
    const markerCustomerId = Number(nextIds.rows[0]?.nextCustomerId ?? 1);
    const markerOrderId = Number(nextIds.rows[0]?.nextOrderId ?? 1);
    const markerOrderEventId = Number(nextIds.rows[0]?.nextOrderEventId ?? 1);
    const markerAfterSaleCaseId = Number(nextIds.rows[0]?.nextAfterSaleCaseId ?? 1);
    const markerAfterSaleRefundId = Number(nextIds.rows[0]?.nextAfterSaleRefundId ?? 1);
    const markerAfterSaleRecordId = Number(nextIds.rows[0]?.nextAfterSaleRecordId ?? 1);
    const markerAfterSaleReminderId = Number(nextIds.rows[0]?.nextAfterSaleReminderId ?? 1);
    const markerWorkbenchOrderId = markerOrderId + 1;
    const markerStoreName = 'Tenant PG Smoke Store';
    const markerProductName = 'Tenant PG Smoke Product';
    const markerCustomerName = 'Tenant PG Smoke Customer';
    const markerWorkbenchOrderNo = `TENANT-PG-WORKBENCH-${markerWorkbenchOrderId}`;
    const markerAfterSaleCaseNo = `TENANT-PG-AFTER-SALE-${markerAfterSaleCaseId}`;
    const markerPaidAmount = 9876.54;
    const markerDiscountAmount = 123.46;
    const markerGrossAmount = 10000;
    const markerNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await pool.query(
      `
        INSERT INTO public.stores (id, name, manager)
        VALUES ($1, $2, $3)
      `,
      [markerStoreId, markerStoreName, 'Smoke Manager'],
    );
    await pool.query(
      `
        INSERT INTO public.products (id, store_id, sku, name, category, price, cost, stock)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [markerProductId, markerStoreId, `tenant-pg-smoke-sku-${markerProductId}`, markerProductName, 'Smoke Category', 1111.11, 100, 99],
    );
    await pool.query(
      `
        INSERT INTO public.customers (id, name, province, registered_at)
        VALUES ($1, $2, $3, $4)
      `,
      [markerCustomerId, markerCustomerName, 'Shanghai', markerNow],
    );
    await pool.query(
      `
        INSERT INTO public.orders (
          id,
          order_no,
          store_id,
          product_id,
          customer_id,
          source,
          quantity,
          paid_amount,
          discount_amount,
          order_status,
          main_status,
          payment_status,
          delivery_status,
          after_sale_status,
          refund_amount,
          paid_at,
          shipped_at,
          completed_at,
          delivery_hours,
          is_new_customer,
          buyer_note,
          seller_remark,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $16, $17, $18, $19, $20, $16, $16
        )
      `,
      [
        markerOrderId,
        `TENANT-PG-SMOKE-${markerOrderId}`,
        markerStoreId,
        markerProductId,
        markerCustomerId,
        'tenant-pg-smoke',
        9,
        markerPaidAmount,
        markerDiscountAmount,
        'completed',
        'completed',
        'paid',
        'shipped',
        'none',
        0,
        markerNow,
        2,
        1,
        '',
        '',
      ],
    );
    await pool.query(
      `
        INSERT INTO public.order_payments (
          order_id,
          payment_no,
          payment_channel,
          payment_status,
          gross_amount,
          discount_amount,
          paid_amount,
          paid_at,
          settled_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $8)
      `,
      [
        markerOrderId,
        `TENANT-PG-SMOKE-PAY-${markerOrderId}`,
        'alipay',
        'paid',
        markerGrossAmount,
        markerDiscountAmount,
        markerPaidAmount,
        markerNow,
      ],
    );
    await pool.query(
      `
        INSERT INTO public.orders (
          id,
          order_no,
          store_id,
          product_id,
          customer_id,
          source,
          quantity,
          paid_amount,
          discount_amount,
          order_status,
          main_status,
          payment_status,
          delivery_status,
          after_sale_status,
          refund_amount,
          paid_at,
          shipped_at,
          completed_at,
          delivery_hours,
          is_new_customer,
          buyer_note,
          seller_remark,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $16, $17, $18, $19, $20, $16, $16
        )
      `,
      [
        markerWorkbenchOrderId,
        markerWorkbenchOrderNo,
        markerStoreId,
        markerProductId,
        markerCustomerId,
        'tenant-pg-after-sale-smoke',
        1,
        321.45,
        0,
        'after_sale',
        'closed',
        'paid',
        'manual_review',
        'processing',
        0,
        markerNow,
        6,
        0,
        'Workbench smoke buyer note',
        'Workbench smoke seller remark',
      ],
    );
    await pool.query(
      `
        INSERT INTO public.order_events (
          id,
          order_id,
          event_type,
          event_title,
          event_detail,
          operator_name,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        markerOrderEventId,
        markerWorkbenchOrderId,
        'fulfillment_failed',
        'Tenant PG fulfillment smoke event',
        'Seeded for tenant PostgreSQL fulfillment workbench verification.',
        'system',
        markerNow,
      ],
    );
    await pool.query(
      `
        INSERT INTO public.after_sale_cases (
          id,
          case_no,
          order_id,
          case_type,
          case_status,
          priority,
          source_channel,
          reason,
          customer_request,
          expectation,
          latest_result,
          sla_deadline_at,
          created_at,
          updated_at,
          closed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '', '', $9, $10, $11, $11, NULL)
      `,
      [
        markerAfterSaleCaseId,
        markerAfterSaleCaseNo,
        markerWorkbenchOrderId,
        'refund',
        'processing',
        'urgent',
        'smoke',
        'Tenant PG after-sale smoke reason',
        'Awaiting tenant PostgreSQL review',
        markerNow,
        markerNow,
      ],
    );
    await pool.query(
      `
        INSERT INTO public.after_sale_refunds (
          id,
          case_id,
          refund_no,
          requested_amount,
          approved_amount,
          refund_status,
          review_note,
          reviewed_by,
          reviewed_at,
          refunded_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, '', NULL, NULL, NULL)
      `,
      [
        markerAfterSaleRefundId,
        markerAfterSaleCaseId,
        `TENANT-PG-REFUND-${markerAfterSaleRefundId}`,
        321.45,
        0,
        'pending_review',
      ],
    );
    await pool.query(
      `
        INSERT INTO public.after_sale_records (
          id,
          case_id,
          record_type,
          title,
          detail,
          operator_name,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        markerAfterSaleRecordId,
        markerAfterSaleCaseId,
        'system',
        'Tenant PG after-sale smoke record',
        'Seeded for tenant PostgreSQL after-sale detail verification.',
        'system',
        markerNow,
      ],
    );
    await pool.query(
      `
        INSERT INTO public.after_sale_reminders (
          id,
          case_id,
          reminder_type,
          reminder_status,
          title,
          detail,
          remind_at,
          resolved_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
      `,
      [
        markerAfterSaleReminderId,
        markerAfterSaleCaseId,
        'timeout',
        'active',
        'Tenant PG after-sale timeout reminder',
        'Seeded for tenant PostgreSQL after-sale workbench verification.',
        markerNow,
      ],
    );

    const ordersListResponse = await fetchJson(
      `${baseUrl}/api/orders?preset=last30Days&page=1&pageSize=20&keyword=TENANT-PG-SMOKE`,
      {
        headers: tenantHeaders,
      },
    );
    if (ordersListResponse.status !== 200) {
      throw new Error(`Tenant orders list failed: ${ordersListResponse.text}`);
    }

    const orderDetailResponse = await fetchJson(`${baseUrl}/api/orders/${markerOrderId}`, {
      headers: tenantHeaders,
    });
    if (orderDetailResponse.status !== 200) {
      throw new Error(`Tenant order detail failed: ${orderDetailResponse.text}`);
    }

    const ordersExportResponse = await fetch(
      `${baseUrl}/api/orders/export?preset=last30Days&keyword=TENANT-PG-SMOKE`,
      {
        headers: tenantHeaders,
      },
    );
    const ordersExportText = await ordersExportResponse.text();
    if (ordersExportResponse.status !== 200) {
      throw new Error(`Tenant orders export failed: ${ordersExportText}`);
    }

    const reportsResponse = await fetchJson(`${baseUrl}/api/reports?preset=last30Days`, {
      headers: tenantHeaders,
    });
    if (reportsResponse.status !== 200) {
      throw new Error(`Tenant business reports failed: ${reportsResponse.text}`);
    }
    const reportsExportResponse = await fetch(`${baseUrl}/api/reports/export?preset=last30Days`, {
      headers: tenantHeaders,
    });
    const reportsExportText = await reportsExportResponse.text();
    if (reportsExportResponse.status !== 200) {
      throw new Error(`Tenant business report export failed: ${reportsExportText}`);
    }

    const productsResponse = await fetchJson(`${baseUrl}/api/products?preset=last30Days`, {
      headers: tenantHeaders,
    });
    if (productsResponse.status !== 200) {
      throw new Error(`Tenant products view failed: ${productsResponse.text}`);
    }

    const customersResponse = await fetchJson(`${baseUrl}/api/customers?preset=last30Days`, {
      headers: tenantHeaders,
    });
    if (customersResponse.status !== 200) {
      throw new Error(`Tenant customers view failed: ${customersResponse.text}`);
    }
    const fulfillmentWorkbenchResponse = await fetchJson(
      `${baseUrl}/api/orders/workbench/fulfillment?preset=last30Days&keyword=TENANT-PG-WORKBENCH`,
      {
        headers: tenantHeaders,
      },
    );
    if (fulfillmentWorkbenchResponse.status !== 200) {
      throw new Error(`Tenant fulfillment workbench failed: ${fulfillmentWorkbenchResponse.text}`);
    }

    const afterSaleWorkbenchResponse = await fetchJson(
      `${baseUrl}/api/after-sales/workbench?preset=last30Days&keyword=TENANT-PG-AFTER-SALE`,
      {
        headers: tenantHeaders,
      },
    );
    if (afterSaleWorkbenchResponse.status !== 200) {
      throw new Error(`Tenant after-sale workbench failed: ${afterSaleWorkbenchResponse.text}`);
    }

    const afterSalesListResponse = await fetchJson(
      `${baseUrl}/api/after-sales?preset=last30Days&page=1&pageSize=20&keyword=TENANT-PG-AFTER-SALE`,
      {
        headers: tenantHeaders,
      },
    );
    if (afterSalesListResponse.status !== 200) {
      throw new Error(`Tenant after-sales list failed: ${afterSalesListResponse.text}`);
    }

    const afterSaleDetailResponse = await fetchJson(`${baseUrl}/api/after-sales/${markerAfterSaleCaseId}`, {
      headers: tenantHeaders,
    });
    if (afterSaleDetailResponse.status !== 200) {
      throw new Error(`Tenant after-sale detail failed: ${afterSaleDetailResponse.text}`);
    }

    await sleep(250);
    const serverLogText = serverLogs.join('');
    const reportsCapabilityMissing = hasTenantAdapterCapabilityWarning(
      serverLogText,
      'getBusinessReports',
    );
    const reportsExportCapabilityMissing = hasTenantAdapterCapabilityWarning(
      serverLogText,
      'exportBusinessReportsCsv',
    );
    const productsCapabilityMissing = hasTenantAdapterCapabilityWarning(
      serverLogText,
      'getProductsView',
    );
    const customersCapabilityMissing = hasTenantAdapterCapabilityWarning(
      serverLogText,
      'getCustomersView',
    );
    const ordersListCapabilityMissing = hasTenantAdapterCapabilityWarning(
      serverLogText,
      'getOrdersList',
    );
    const orderDetailCapabilityMissing = hasTenantAdapterCapabilityWarning(
      serverLogText,
      'getOrderDetail',
    );
    const ordersExportCapabilityMissing = hasTenantAdapterCapabilityWarning(
      serverLogText,
      'exportOrdersCsv',
    );
    const fulfillmentWorkbenchCapabilityMissing = hasTenantAdapterCapabilityWarning(
      serverLogText,
      'getOrderFulfillmentWorkbench',
    );
    const afterSaleWorkbenchCapabilityMissing = hasTenantAdapterCapabilityWarning(
      serverLogText,
      'getAfterSaleWorkbench',
    );
    const afterSalesListCapabilityMissing = hasTenantAdapterCapabilityWarning(
      serverLogText,
      'getAfterSaleCases',
    );
    const afterSaleDetailCapabilityMissing = hasTenantAdapterCapabilityWarning(
      serverLogText,
      'getAfterSaleDetail',
    );
    const reportsContainsPgMarker = Boolean(
      reportsResponse.json?.storeStats?.some((item) => item.storeName === markerStoreName) ||
        reportsResponse.json?.productStats?.some((item) => item.productName === markerProductName),
    );
    const reportsExportContainsPgMarker =
      reportsExportText.includes(markerStoreName) || reportsExportText.includes(markerProductName);
    const productsContainsPgMarker = Boolean(
      productsResponse.json?.ranking?.some(
        (item) => item.name === markerProductName && item.storeName === markerStoreName,
      ),
    );
    const customersContainsPgMarker = Boolean(
      customersResponse.json?.customerList?.some((item) => item.name === markerCustomerName),
    );
    const ordersListContainsPgMarker = Boolean(
      ordersListResponse.json?.list?.some?.(
        (item) => item.orderNo === `TENANT-PG-SMOKE-${markerOrderId}` && item.storeName === markerStoreName,
      ),
    );
    const orderDetailContainsPgMarker =
      orderDetailResponse.json?.order?.orderNo === `TENANT-PG-SMOKE-${markerOrderId}` &&
      orderDetailResponse.json?.order?.productName === markerProductName;
    const ordersExportContainsPgMarker =
      ordersExportText.includes(`TENANT-PG-SMOKE-${markerOrderId}`) &&
      ordersExportText.includes(markerProductName);
    const fulfillmentWorkbenchContainsPgMarker = Boolean(
      fulfillmentWorkbenchResponse.json?.exceptionOrders?.some?.(
        (item) => item.orderNo === markerWorkbenchOrderNo && item.storeName === markerStoreName,
      ) ||
        fulfillmentWorkbenchResponse.json?.logs?.some?.(
          (item) =>
            item.orderNo === markerWorkbenchOrderNo &&
            String(item.eventTitle ?? '').includes('Tenant PG fulfillment smoke event'),
        ),
    );
    const afterSaleWorkbenchContainsPgMarker = Boolean(
      afterSaleWorkbenchResponse.json?.pendingCases?.some?.(
        (item) => item.caseNo === markerAfterSaleCaseNo && item.orderNo === markerWorkbenchOrderNo,
      ) ||
        afterSaleWorkbenchResponse.json?.timeoutCases?.some?.(
          (item) => item.caseNo === markerAfterSaleCaseNo,
        ) ||
        afterSaleWorkbenchResponse.json?.reminders?.some?.(
          (item) => item.caseNo === markerAfterSaleCaseNo,
        ),
    );
    const afterSalesListContainsPgMarker = Boolean(
      afterSalesListResponse.json?.list?.some?.(
        (item) => item.caseNo === markerAfterSaleCaseNo && item.orderNo === markerWorkbenchOrderNo,
      ),
    );
    const afterSaleDetailContainsPgMarker =
      afterSaleDetailResponse.json?.caseInfo?.caseNo === markerAfterSaleCaseNo &&
      afterSaleDetailResponse.json?.order?.orderNo === markerWorkbenchOrderNo &&
      afterSaleDetailResponse.json?.refund?.refundStatus === 'pending_review';

    if (!reportsCapabilityMissing && !reportsContainsPgMarker) {
      throw new Error('Tenant business reports did not expose PostgreSQL-only smoke marker data.');
    }
    if (!reportsExportCapabilityMissing && !reportsExportContainsPgMarker) {
      throw new Error('Tenant business report export did not expose PostgreSQL-only smoke marker data.');
    }
    if (!productsCapabilityMissing && !productsContainsPgMarker) {
      throw new Error('Tenant products view did not expose PostgreSQL-only smoke marker data.');
    }
    if (!customersCapabilityMissing && !customersContainsPgMarker) {
      throw new Error('Tenant customers view did not expose PostgreSQL-only smoke marker data.');
    }
    if (!ordersListCapabilityMissing && !ordersListContainsPgMarker) {
      throw new Error('Tenant orders list did not expose PostgreSQL-only smoke marker data.');
    }
    if (!orderDetailCapabilityMissing && !orderDetailContainsPgMarker) {
      throw new Error('Tenant order detail did not expose PostgreSQL-only smoke marker data.');
    }
    if (!ordersExportCapabilityMissing && !ordersExportContainsPgMarker) {
      throw new Error('Tenant orders export did not expose PostgreSQL-only smoke marker data.');
    }
    if (!fulfillmentWorkbenchCapabilityMissing && !fulfillmentWorkbenchContainsPgMarker) {
      throw new Error('Tenant fulfillment workbench did not expose PostgreSQL-only smoke marker data.');
    }
    if (!afterSaleWorkbenchCapabilityMissing && !afterSaleWorkbenchContainsPgMarker) {
      throw new Error('Tenant after-sale workbench did not expose PostgreSQL-only smoke marker data.');
    }
    if (!afterSalesListCapabilityMissing && !afterSalesListContainsPgMarker) {
      throw new Error('Tenant after-sales list did not expose PostgreSQL-only smoke marker data.');
    }
    if (!afterSaleDetailCapabilityMissing && !afterSaleDetailContainsPgMarker) {
      throw new Error('Tenant after-sale detail did not expose PostgreSQL-only smoke marker data.');
    }

    const workspaceSeed = await pool.query(`
      SELECT wa.feature_key AS "featureKey"
      FROM public.workspace_actions wa
      INNER JOIN public.workspace_rules wr ON wr.feature_key = wa.feature_key
      INNER JOIN public.workspace_tasks wt ON wt.feature_key = wa.feature_key
      GROUP BY wa.feature_key
      ORDER BY wa.feature_key ASC
      LIMIT 1
    `);
    let workspaceFeatureKey = String(workspaceSeed.rows[0]?.featureKey ?? '');
    if (!workspaceFeatureKey) {
      workspaceFeatureKey = 'move';
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      await pool.query(
        `
          INSERT INTO public.workspace_modules (
            feature_key,
            feature_label,
            group_key,
            group_label,
            status_tag,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (feature_key) DO NOTHING
        `,
        [workspaceFeatureKey, 'Move', 'sales', 'Sales', 'Active', now],
      );
      await pool.query(
        `
          INSERT INTO public.workspace_actions (
            id,
            feature_key,
            action_key,
            title,
            description,
            status,
            run_count,
            last_run_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [1, workspaceFeatureKey, 'smoke-action', 'Smoke action', 'Workspace smoke action', 'ready', 0, null],
      );
      await pool.query(
        `
          INSERT INTO public.workspace_rules (
            id,
            feature_key,
            name,
            description,
            enabled,
            scope_text,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [1, workspaceFeatureKey, 'Smoke rule', 'Workspace smoke rule', 1, 'default', now],
      );
      await pool.query(
        `
          INSERT INTO public.workspace_tasks (
            id,
            feature_key,
            title,
            description,
            owner,
            priority,
            status,
            due_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [1, workspaceFeatureKey, 'Smoke task', 'Workspace smoke task', 'system', 'medium', 'todo', dueAt],
      );
    }

    const workspaceOverviewResponse = await fetchJson(`${baseUrl}/api/workspaces/${workspaceFeatureKey}`, {
      headers: tenantHeaders,
    });
    if (workspaceOverviewResponse.status !== 200) {
      throw new Error(`Tenant workspace overview failed: ${workspaceOverviewResponse.text}`);
    }
    const workspaceOverview = workspaceOverviewResponse.json;
    const firstAction = workspaceOverview?.actions?.[0];
    const firstRule = workspaceOverview?.rules?.[0];
    const firstTask = workspaceOverview?.tasks?.[0];
    if (!firstAction || !firstRule || !firstTask) {
      throw new Error(`Tenant workspace overview is missing action/rule/task seed data for ${workspaceFeatureKey}.`);
    }

    const logCountBefore = await pool.query(
      `SELECT COUNT(*)::int AS count FROM public.workspace_logs WHERE feature_key = $1`,
      [workspaceFeatureKey],
    );

    const actionRunResponse = await fetchJson(
      `${baseUrl}/api/workspaces/${workspaceFeatureKey}/actions/${firstAction.id}/run`,
      {
        method: 'POST',
        headers: tenantHeaders,
      },
    );
    if (actionRunResponse.status !== 200) {
      throw new Error(`Tenant workspace action run failed: ${actionRunResponse.text}`);
    }

    const toggleRuleResponse = await fetchJson(
      `${baseUrl}/api/workspaces/${workspaceFeatureKey}/rules/${firstRule.id}/toggle`,
      {
        method: 'POST',
        headers: tenantHeaders,
      },
    );
    if (toggleRuleResponse.status !== 200) {
      throw new Error(`Tenant workspace rule toggle failed: ${toggleRuleResponse.text}`);
    }

    const updateTaskResponse = await fetchJson(
      `${baseUrl}/api/workspaces/${workspaceFeatureKey}/tasks/${firstTask.id}/status`,
      {
        method: 'POST',
        headers: tenantJsonHeaders,
        body: JSON.stringify({
          status: 'done',
        }),
      },
    );
    if (updateTaskResponse.status !== 200) {
      throw new Error(`Tenant workspace task update failed: ${updateTaskResponse.text}`);
    }

    const refreshedWorkspaceResponse = await fetchJson(`${baseUrl}/api/workspaces/${workspaceFeatureKey}`, {
      headers: tenantHeaders,
    });
    if (refreshedWorkspaceResponse.status !== 200) {
      throw new Error(`Tenant refreshed workspace overview failed: ${refreshedWorkspaceResponse.text}`);
    }

    const actionCheck = await pool.query(
      `SELECT run_count AS "runCount" FROM public.workspace_actions WHERE id = $1 AND feature_key = $2`,
      [firstAction.id, workspaceFeatureKey],
    );
    const ruleCheck = await pool.query(
      `SELECT enabled FROM public.workspace_rules WHERE id = $1 AND feature_key = $2`,
      [firstRule.id, workspaceFeatureKey],
    );
    const taskCheck = await pool.query(
      `SELECT status FROM public.workspace_tasks WHERE id = $1 AND feature_key = $2`,
      [firstTask.id, workspaceFeatureKey],
    );
    const logCountAfter = await pool.query(
      `SELECT COUNT(*)::int AS count FROM public.workspace_logs WHERE feature_key = $1`,
      [workspaceFeatureKey],
    );

    const actionRunCount = Number(actionCheck.rows[0]?.runCount ?? 0);
    const ruleEnabled = Number(ruleCheck.rows[0]?.enabled ?? 0);
    const taskStatus = String(taskCheck.rows[0]?.status ?? '');
    const logsBefore = Number(logCountBefore.rows[0]?.count ?? 0);
    const logsAfter = Number(logCountAfter.rows[0]?.count ?? 0);

    if (actionRunCount < Number(firstAction.runCount ?? 0) + 1) {
      throw new Error('Tenant PostgreSQL workspace action run count did not advance.');
    }
    if (Boolean(ruleEnabled) === Boolean(firstRule.enabled)) {
      throw new Error('Tenant PostgreSQL workspace rule toggle did not persist.');
    }
    if (taskStatus !== 'done') {
      throw new Error(`Tenant PostgreSQL workspace task status did not persist: ${taskStatus}`);
    }
    if (logsAfter < logsBefore + 3) {
      throw new Error('Tenant PostgreSQL workspace log count did not increase as expected.');
    }

    const systemMonitoringModuleNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await pool.query(
      `
        INSERT INTO public.workspace_modules (
          feature_key,
          feature_label,
          group_key,
          group_label,
          status_tag,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (feature_key) DO NOTHING
      `,
      ['system-monitoring', 'System Monitoring', 'ops', 'Operations', 'Active', systemMonitoringModuleNow],
    );

    const systemAlertSeedIdResult = await pool.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM public.system_alerts`,
    );
    const systemAlertSeedId = Number(systemAlertSeedIdResult.rows[0]?.nextId ?? 1);

    await pool.query(
      `
        INSERT INTO public.system_alerts (
          id,
          alert_key,
          alert_type,
          severity,
          status,
          source_count,
          title,
          detail,
          first_triggered_at,
          last_triggered_at,
          acknowledged_at,
          resolved_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (id) DO UPDATE SET
          alert_key = EXCLUDED.alert_key,
          alert_type = EXCLUDED.alert_type,
          severity = EXCLUDED.severity,
          status = EXCLUDED.status,
          source_count = EXCLUDED.source_count,
          title = EXCLUDED.title,
          detail = EXCLUDED.detail,
          first_triggered_at = EXCLUDED.first_triggered_at,
          last_triggered_at = EXCLUDED.last_triggered_at,
          acknowledged_at = EXCLUDED.acknowledged_at,
          resolved_at = EXCLUDED.resolved_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        systemAlertSeedId,
        `tenant-metrics-alert-${systemAlertSeedId}`,
        'api_failure',
        'warning',
        'open',
        1,
        'Tenant metrics smoke alert',
        'Seeded for tenant PostgreSQL metrics smoke verification.',
        systemMonitoringModuleNow,
        systemMonitoringModuleNow,
        null,
        null,
        systemMonitoringModuleNow,
      ],
    );

    const systemAlertRowResult = await pool.query(
      `
        SELECT
          id,
          status,
          acknowledged_at AS "acknowledgedAt",
          updated_at AS "updatedAt"
        FROM public.system_alerts
        WHERE id = $1
      `,
      [systemAlertSeedId],
    );
    const systemAlertRow = systemAlertRowResult.rows[0];
    if (!systemAlertRow?.id) {
      throw new Error('Tenant PostgreSQL system alert seed is missing.');
    }

    const alertLogCountBefore = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM public.workspace_logs
        WHERE feature_key = 'system-monitoring'
          AND log_type = 'alert'
      `,
    );

    const systemAlertResponse = await fetchJson(
      `${baseUrl}/api/workspaces/system-monitoring/alerts/${systemAlertRow.id}/status`,
      {
        method: 'POST',
        headers: tenantJsonHeaders,
        body: JSON.stringify({
          status: 'acknowledged',
        }),
      },
    );
    if (systemAlertResponse.status !== 200 || systemAlertResponse.json?.status !== 'acknowledged') {
      throw new Error(`Tenant system alert update failed: ${systemAlertResponse.text}`);
    }

    const systemAlertAfter = await pool.query(
      `
        SELECT
          status,
          acknowledged_at AS "acknowledgedAt",
          updated_at AS "updatedAt"
        FROM public.system_alerts
        WHERE id = $1
      `,
      [systemAlertRow.id],
    );
    const alertLogCountAfter = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM public.workspace_logs
        WHERE feature_key = 'system-monitoring'
          AND log_type = 'alert'
      `,
    );
    const updatedAlert = systemAlertAfter.rows[0];
    const systemAlertStatus = String(updatedAlert?.status ?? '');
    const systemAlertAcknowledgedAt = String(updatedAlert?.acknowledgedAt ?? '');
    const systemAlertUpdatedAt = String(updatedAlert?.updatedAt ?? '');
    const alertLogsBefore = Number(alertLogCountBefore.rows[0]?.count ?? 0);
    const alertLogsAfter = Number(alertLogCountAfter.rows[0]?.count ?? 0);

    if (systemAlertStatus !== 'acknowledged') {
      throw new Error(`Tenant PostgreSQL system alert status did not persist: ${systemAlertStatus}`);
    }
    if (!systemAlertAcknowledgedAt) {
      throw new Error('Tenant PostgreSQL system alert acknowledged_at was not set.');
    }
    if (!systemAlertUpdatedAt) {
      throw new Error('Tenant PostgreSQL system alert updated_at is empty.');
    }
    if (alertLogsAfter < alertLogsBefore + 1) {
      throw new Error('Tenant PostgreSQL system alert log count did not increase as expected.');
    }

    let tenantSystemAlertShadowDetailVerified = false;
    let shadowDetailStatus = null;
    const systemMonitoringDetailResponse = await fetchJson(`${baseUrl}/api/workspaces/system-monitoring/detail`, {
      headers: tenantHeaders,
    });
    if (systemMonitoringDetailResponse.status === 200) {
      const detailAlert = systemMonitoringDetailResponse.json?.alerts?.find?.(
        (item) => Number(item?.id ?? 0) === Number(systemAlertRow.id),
      );
      if (detailAlert && String(detailAlert.status ?? '') === 'acknowledged') {
        tenantSystemAlertShadowDetailVerified = true;
        shadowDetailStatus = String(detailAlert.status ?? '');
      }
    }
    if (!tenantSystemAlertShadowDetailVerified) {
      throw new Error(
        `Tenant PostgreSQL system-monitoring detail did not reflect acknowledged alert ${systemAlertRow.id}: ${JSON.stringify(
          systemMonitoringDetailResponse.json,
        )}`,
      );
    }

    const backupRunResponse = await fetchJson(`${baseUrl}/api/workspaces/system-monitoring/backups/run`, {
      method: 'POST',
      headers: tenantJsonHeaders,
      body: JSON.stringify({}),
    });
    if (backupRunResponse.status !== 200 || backupRunResponse.json?.runStatus !== 'success') {
      throw new Error(`Tenant backup run failed: ${backupRunResponse.text}`);
    }
    const backupPersisted = await pool.query(
      `
        SELECT
          backup_no AS "backupNo",
          run_status AS "runStatus"
        FROM public.system_backup_runs
        WHERE backup_no = $1
      `,
      [backupRunResponse.json?.backupNo ?? null],
    );
    if (
      backupPersisted.rowCount !== 1 ||
      String(backupPersisted.rows[0]?.runStatus ?? '') !== 'success'
    ) {
      throw new Error(
        `Tenant PostgreSQL backup run did not persist returned backup ${String(
          backupRunResponse.json?.backupNo ?? '',
        )}.`,
      );
    }

    const logArchiveResponse = await fetchJson(`${baseUrl}/api/workspaces/system-monitoring/log-archives/run`, {
      method: 'POST',
      headers: tenantJsonHeaders,
      body: JSON.stringify({}),
    });
    if (logArchiveResponse.status !== 200 || !logArchiveResponse.json?.archiveNo) {
      throw new Error(`Tenant log archive run failed: ${logArchiveResponse.text}`);
    }
    const archivePersisted = await pool.query(
      `
        SELECT archive_no AS "archiveNo"
        FROM public.system_log_archives
        WHERE archive_no = $1
      `,
      [logArchiveResponse.json?.archiveNo ?? null],
    );
    if (archivePersisted.rowCount !== 1) {
      throw new Error(
        `Tenant PostgreSQL log archive did not persist returned archive ${String(
          logArchiveResponse.json?.archiveNo ?? '',
        )}.`,
      );
    }

    const recoveryDrillResponse = await fetchJson(`${baseUrl}/api/workspaces/system-monitoring/recovery-drills/run`, {
      method: 'POST',
      headers: tenantJsonHeaders,
      body: JSON.stringify({}),
    });
    if (recoveryDrillResponse.status !== 200 || recoveryDrillResponse.json?.status !== 'success') {
      throw new Error(`Tenant recovery drill failed: ${recoveryDrillResponse.text}`);
    }
    const recoveryPersisted = await pool.query(
      `
        SELECT
          drill_no AS "drillNo",
          drill_status AS "drillStatus"
        FROM public.system_recovery_drills
        WHERE drill_no = $1
      `,
      [recoveryDrillResponse.json?.drillNo ?? null],
    );
    if (
      recoveryPersisted.rowCount !== 1 ||
      String(recoveryPersisted.rows[0]?.drillStatus ?? '') !== 'success'
    ) {
      throw new Error(
        `Tenant PostgreSQL recovery drill did not persist returned drill ${String(
          recoveryDrillResponse.json?.drillNo ?? '',
        )}.`,
      );
    }

    const metricsResponse = await fetch(`${baseUrl}/api/metrics`, {
      headers: {
        ...tenantHeaders,
        'x-metrics-token': 'saas-tenant-pg-metrics-token-20260420',
      },
    });
    const metricsText = await metricsResponse.text();
    if (metricsResponse.status !== 200) {
      throw new Error(`Tenant metrics failed: ${metricsText}`);
    }

    const metricsAlertStats = await pool.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE status != 'resolved')::int AS "activeCount",
          COUNT(*) FILTER (WHERE status != 'resolved' AND severity = 'critical')::int AS "criticalCount"
        FROM public.system_alerts
      `,
    );
    const metricsBackupStats = await pool.query(
      `
        SELECT COUNT(*) FILTER (WHERE run_status = 'success')::int AS "successCount"
        FROM public.system_backup_runs
      `,
    );
    const expectedMetricsActiveAlerts = Number(metricsAlertStats.rows[0]?.activeCount ?? 0);
    const expectedMetricsCriticalAlerts = Number(metricsAlertStats.rows[0]?.criticalCount ?? 0);
    const expectedMetricsSuccessBackups = Number(metricsBackupStats.rows[0]?.successCount ?? 0);
    const metricsActiveAlerts = readPrometheusGauge(metricsText, 'sale_compass_system_alerts_active');
    const metricsCriticalAlerts = readPrometheusGauge(metricsText, 'sale_compass_system_alerts_critical');
    const metricsSuccessBackups = readPrometheusGauge(metricsText, 'sale_compass_backups_success_total');
    const metricsDatabaseSize = readPrometheusGauge(metricsText, 'sale_compass_database_size_bytes');
    if (metricsActiveAlerts !== expectedMetricsActiveAlerts) {
      throw new Error(
        `Tenant metrics active alert count mismatch: expected ${expectedMetricsActiveAlerts}, got ${metricsActiveAlerts}.`,
      );
    }
    if (metricsCriticalAlerts !== expectedMetricsCriticalAlerts) {
      throw new Error(
        `Tenant metrics critical alert count mismatch: expected ${expectedMetricsCriticalAlerts}, got ${metricsCriticalAlerts}.`,
      );
    }
    if (metricsSuccessBackups !== expectedMetricsSuccessBackups) {
      throw new Error(
        `Tenant metrics backup success count mismatch: expected ${expectedMetricsSuccessBackups}, got ${metricsSuccessBackups}.`,
      );
    }
    if (metricsDatabaseSize <= 0) {
      throw new Error(`Tenant metrics database size is invalid: ${metricsDatabaseSize}.`);
    }
    const tenantMetricsVerified = true;

    const storeAuthCreateResponse = await fetchJson(`${baseUrl}/api/stores/auth-sessions`, {
      method: 'POST',
      headers: tenantJsonHeaders,
      body: JSON.stringify({
        platform: 'xianyu',
        source: 'tenant-pg-smoke',
        authType: 11,
      }),
    });
    if (storeAuthCreateResponse.status !== 200 || !storeAuthCreateResponse.json?.sessionId) {
      throw new Error(`Tenant store auth session create failed: ${storeAuthCreateResponse.text}`);
    }
    const createdStoreAuthSessionId = String(storeAuthCreateResponse.json.sessionId);
    const createdStoreAuthSessionPersisted = await pool.query(
      `
        SELECT
          session_id AS "sessionId",
          platform,
          source,
          auth_type AS "authType",
          status,
          integration_mode AS "integrationMode"
        FROM public.store_auth_sessions
        WHERE session_id = $1
      `,
      [createdStoreAuthSessionId],
    );
    const tenantStoreAuthSessionCreateWriteVerified =
      createdStoreAuthSessionPersisted.rowCount === 1 &&
      String(createdStoreAuthSessionPersisted.rows[0]?.platform ?? '') === 'xianyu' &&
      String(createdStoreAuthSessionPersisted.rows[0]?.status ?? '') === 'pending' &&
      String(createdStoreAuthSessionPersisted.rows[0]?.source ?? '') === 'tenant-pg-smoke';

    const createdStoreAuthSessionDetailResponse = await fetchJson(
      `${baseUrl}/api/stores/auth-sessions/${createdStoreAuthSessionId}`,
      {
        headers: tenantHeaders,
      },
    );
    if (createdStoreAuthSessionDetailResponse.status !== 200) {
      throw new Error(
        `Tenant store auth session detail failed: ${createdStoreAuthSessionDetailResponse.text}`,
      );
    }
    const tenantStoreAuthSessionDetailVerified =
      String(createdStoreAuthSessionDetailResponse.json?.sessionId ?? '') === createdStoreAuthSessionId &&
      String(createdStoreAuthSessionDetailResponse.json?.platform ?? '') === 'xianyu';

    const simulatedSessionId = crypto.randomUUID();
    const simulatedSessionNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const simulatedSessionExpiresAt = new Date(Date.now() + 15 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    await pool.query(
      `
        INSERT INTO public.store_auth_sessions (
          session_id,
          platform,
          source,
          auth_type,
          status,
          created_at,
          expires_at,
          store_id,
          owner_account_id,
          created_by_user_id,
          reauthorize,
          integration_mode,
          provider_key,
          provider_label,
          provider_state,
          provider_auth_url,
          callback_url,
          next_step,
          profile_sync_status
        ) VALUES (
          $1, 'xianyu', 'tenant-pg-simulated', 11, 'pending', $2, $3, NULL, NULL, $4, 0, 'simulated', 'manual-simulated', 'Manual Simulated', NULL, NULL, NULL, 'manual_complete', 'pending'
        )
      `,
      [simulatedSessionId, simulatedSessionNow, simulatedSessionExpiresAt, tenantUserId],
    );
    const completeStoreAuthSessionResponse = await fetchJson(
      `${baseUrl}/api/stores/auth-sessions/${simulatedSessionId}/complete`,
      {
        method: 'POST',
        headers: tenantJsonHeaders,
        body: JSON.stringify({
          mobile: '13800138000',
          nickname: 'Tenant PG Simulated Shop',
          loginMode: 'sms',
        }),
      },
    );
    if (completeStoreAuthSessionResponse.status !== 200 || !completeStoreAuthSessionResponse.json?.storeId) {
      throw new Error(
        `Tenant store auth session complete failed: ${completeStoreAuthSessionResponse.text}`,
      );
    }
    const completedStoreId = Number(completeStoreAuthSessionResponse.json.storeId);
    const completedStoreAuthSessionPersisted = await pool.query(
      `
        SELECT
          status,
          store_id AS "storeId",
          owner_account_id AS "ownerAccountId",
          profile_sync_status AS "profileSyncStatus"
        FROM public.store_auth_sessions
        WHERE session_id = $1
      `,
      [simulatedSessionId],
    );
    const completedManagedStorePersisted = await pool.query(
      `
        SELECT
          shop_name AS "shopName",
          auth_status AS "authStatus",
          connection_status AS "connectionStatus"
        FROM public.managed_stores
        WHERE id = $1
      `,
      [completedStoreId],
    );
    const tenantStoreAuthSessionCompleteWriteVerified =
      completedStoreAuthSessionPersisted.rowCount === 1 &&
      String(completedStoreAuthSessionPersisted.rows[0]?.status ?? '') === 'completed' &&
      Number(completedStoreAuthSessionPersisted.rows[0]?.storeId ?? 0) === completedStoreId &&
      Number(completedStoreAuthSessionPersisted.rows[0]?.ownerAccountId ?? 0) > 0 &&
      String(completedStoreAuthSessionPersisted.rows[0]?.profileSyncStatus ?? '') === 'success' &&
      completedManagedStorePersisted.rowCount === 1 &&
      String(completedManagedStorePersisted.rows[0]?.shopName ?? '') === 'Tenant PG Simulated Shop';

    const webSessionSyncSessionId = crypto.randomUUID();
    const webSessionSyncNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const webSessionSyncExpiresAt = new Date(Date.now() + 15 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    await pool.query(
      `
        INSERT INTO public.store_auth_sessions (
          session_id,
          platform,
          source,
          auth_type,
          status,
          created_at,
          expires_at,
          store_id,
          owner_account_id,
          created_by_user_id,
          reauthorize,
          integration_mode,
          provider_key,
          provider_label,
          provider_state,
          provider_auth_url,
          callback_url,
          next_step,
          profile_sync_status
        ) VALUES (
          $1, 'xianyu', 'tenant-pg-web-session', 11, 'pending', $2, $3, NULL, NULL, $4, 0, 'xianyu_web_session', 'xianyu-web-session', 'Xianyu Web Session', NULL, NULL, NULL, 'manual_complete', 'pending'
        )
      `,
      [webSessionSyncSessionId, webSessionSyncNow, webSessionSyncExpiresAt, tenantUserId],
    );
    const webSessionSyncResponse = await fetchJson(
      `${baseUrl}/api/stores/auth-sessions/${webSessionSyncSessionId}/web-session-sync`,
      {
        method: 'POST',
        headers: tenantJsonHeaders,
        body: JSON.stringify({
          cookieText: 'cna=tenant-pg; _m_h5_tk=tenant-pg-smoke-token_12345; xlly_s=1',
          providerUserId: 'tenant-pg-provider-user',
          providerShopId: 'tenant-pg-provider-shop',
          providerShopName: 'Tenant PG Web Session Shop',
          mobile: '13800138001',
          nickname: 'Tenant PG Web Session Shop',
          scopeText: 'basic,trade',
          refreshToken: 'tenant-pg-refresh-token',
        }),
      },
    );
    if (webSessionSyncResponse.status !== 200 || !webSessionSyncResponse.json?.storeId) {
      throw new Error(`Tenant store web-session sync failed: ${webSessionSyncResponse.text}`);
    }
    const webSessionSyncStoreId = Number(webSessionSyncResponse.json.storeId);
    const webSessionSyncPersisted = await pool.query(
      `
        SELECT
          sas.status,
          sas.store_id AS "storeId",
          sas.next_step AS "nextStep",
          sas.profile_sync_status AS "profileSyncStatus",
          sas.provider_access_token_received_at AS "providerAccessTokenReceivedAt",
          spc.id AS "credentialId",
          spc.credential_type AS "credentialType",
          spc.provider_user_id AS "providerUserId",
          spc.provider_shop_id AS "providerShopId",
          spc.provider_shop_name AS "providerShopName"
        FROM public.store_auth_sessions sas
        LEFT JOIN public.store_platform_credentials spc ON spc.session_id = sas.session_id
        WHERE sas.session_id = $1
        ORDER BY spc.id DESC
        LIMIT 1
      `,
      [webSessionSyncSessionId],
    );
    const webSessionManagedStorePersisted = await pool.query(
      `
        SELECT
          shop_name AS "shopName",
          provider_store_id AS "providerStoreId",
          provider_user_id AS "providerUserId",
          credential_id AS "credentialId"
        FROM public.managed_stores
        WHERE id = $1
      `,
      [webSessionSyncStoreId],
    );
    const tenantStoreAuthWebSessionSyncWriteVerified =
      webSessionSyncPersisted.rowCount === 1 &&
      String(webSessionSyncPersisted.rows[0]?.status ?? '') === 'completed' &&
      Number(webSessionSyncPersisted.rows[0]?.storeId ?? 0) === webSessionSyncStoreId &&
      String(webSessionSyncPersisted.rows[0]?.nextStep ?? '') === 'done' &&
      String(webSessionSyncPersisted.rows[0]?.profileSyncStatus ?? '') === 'success' &&
      String(webSessionSyncPersisted.rows[0]?.credentialType ?? '') === 'web_session' &&
      String(webSessionSyncPersisted.rows[0]?.providerUserId ?? '') === 'tenant-pg-provider-user' &&
      String(webSessionSyncPersisted.rows[0]?.providerShopId ?? '') === 'tenant-pg-provider-shop' &&
      String(webSessionSyncPersisted.rows[0]?.providerShopName ?? '') === 'Tenant PG Web Session Shop' &&
      String(webSessionManagedStorePersisted.rows[0]?.shopName ?? '') === 'Tenant PG Web Session Shop' &&
      String(webSessionManagedStorePersisted.rows[0]?.providerStoreId ?? '') === 'tenant-pg-provider-shop' &&
      String(webSessionManagedStorePersisted.rows[0]?.providerUserId ?? '') === 'tenant-pg-provider-user' &&
      Number(webSessionManagedStorePersisted.rows[0]?.credentialId ?? 0) > 0;

    const storeAuthEventIdResult = await pool.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM public.store_credential_events`,
    );
    const storeAuthEventId = Number(storeAuthEventIdResult.rows[0]?.nextId ?? 1);
    const storeAuthEventMarker = 'Tenant PG store auth credential event marker';
    await pool.query(
      `
        INSERT INTO public.store_credential_events (
          id,
          store_id,
          session_id,
          credential_id,
          event_type,
          status,
          detail,
          source,
          risk_level,
          verification_url,
          operator_user_id,
          created_at
        ) VALUES (
          $1, $2, $3, $4, 'browser_renewed', 'warning', $5, 'browser_renew', 'warning', 'https://tenant-pg-store.example.com/manual', $6, $7
        )
      `,
      [
        storeAuthEventId,
        webSessionSyncStoreId,
        webSessionSyncSessionId,
        Number(webSessionSyncPersisted.rows[0]?.credentialId ?? 0),
        storeAuthEventMarker,
        tenantUserId,
        new Date().toISOString().slice(0, 19).replace('T', ' '),
      ],
    );
    const storeAuthSessionEventsResponse = await fetchJson(
      `${baseUrl}/api/stores/auth-sessions/${webSessionSyncSessionId}/credential-events`,
      {
        headers: tenantHeaders,
      },
    );
    if (storeAuthSessionEventsResponse.status !== 200) {
      throw new Error(
        `Tenant store auth session credential events failed: ${storeAuthSessionEventsResponse.text}`,
      );
    }
    const storeAuthStoreEventsResponse = await fetchJson(
      `${baseUrl}/api/stores/${webSessionSyncStoreId}/credential-events`,
      {
        headers: tenantHeaders,
      },
    );
    if (storeAuthStoreEventsResponse.status !== 200) {
      throw new Error(
        `Tenant store credential events failed: ${storeAuthStoreEventsResponse.text}`,
      );
    }
    await sleep(200);
    const storeAuthLogText = serverLogs.join('');
    const tenantStoreAuthSessionEventsVerified = Boolean(
      storeAuthSessionEventsResponse.json?.events?.some?.(
        (item) =>
          String(item?.detail ?? '') === storeAuthEventMarker &&
          String(item?.eventType ?? '') === 'browser_renewed',
      ),
    );
    const tenantStoreCredentialEventsVerified = Boolean(
      storeAuthStoreEventsResponse.json?.events?.some?.(
        (item) =>
          String(item?.detail ?? '') === storeAuthEventMarker &&
          String(item?.eventType ?? '') === 'browser_renewed',
      ),
    );
    const tenantStoreCredentialEventSessionCapabilityMissing = hasTenantAdapterCapabilityWarning(
      storeAuthLogText,
      'getStoreCredentialEventsBySession',
    );
    const tenantStoreCredentialEventStoreCapabilityMissing = hasTenantAdapterCapabilityWarning(
      storeAuthLogText,
      'getStoreCredentialEvents',
    );

    const fulfillmentModuleNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await pool.query(
      `
        INSERT INTO public.workspace_modules (
          feature_key,
          feature_label,
          group_key,
          group_label,
          status_tag,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (feature_key) DO NOTHING
      `,
      [
        'distribution-source',
        'Distribution Source',
        'distribution',
        'Distribution',
        'Active',
        fulfillmentModuleNow,
      ],
    );

    const sourceSystemResult = await pool.query(
      `
        SELECT
          id,
          enabled,
          callback_token_masked AS "callbackTokenMasked"
        FROM public.supply_source_systems
        ORDER BY id
        LIMIT 1
      `,
    );
    let sourceSystem = sourceSystemResult.rows[0];
    if (!sourceSystem) {
      const sourceSystemIdResult = await pool.query(
        `SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM public.supply_source_systems`,
      );
      const sourceSystemId = Number(sourceSystemIdResult.rows[0]?.nextId ?? 1);
      const seededMaskedToken = 'sst***oke';
      await pool.query(
        `
          INSERT INTO public.supply_source_systems (
            id,
            system_key,
            system_name,
            adapter_key,
            endpoint_url,
            callback_token,
            callback_token_masked,
            enabled,
            system_status,
            sync_mode,
            sync_interval_minutes,
            order_push_enabled,
            refund_callback_enabled,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, 1, 'online', 'manual', 60, 1, 1, $8, $8
          )
        `,
        [
          sourceSystemId,
          `tenant-pg-source-system-${sourceSystemId}`,
          'Tenant PG Smoke Source System',
          'tenant-pg-smoke-adapter',
          'https://tenant-pg-source.example.com',
          'tenant-pg-source-token',
          seededMaskedToken,
          fulfillmentModuleNow,
        ],
      );
      sourceSystem = {
        id: sourceSystemId,
        enabled: 1,
        callbackTokenMasked: seededMaskedToken,
      };
    }

    let tenantSourceSystemToggleWriteVerified = false;
    let tenantSourceSystemTokenRotateWriteVerified = false;
    try {
      const sourceSystemToggleResponse = await fetchJson(
        `${baseUrl}/api/workspaces/distribution-source/source-systems/${sourceSystem.id}/toggle`,
        {
          method: 'POST',
          headers: tenantHeaders,
        },
      );
      if (sourceSystemToggleResponse.status === 200) {
        const expectedSourceSystemEnabled = Number(sourceSystem.enabled ?? 0) === 1 ? 0 : 1;
        const sourceSystemPersisted = await pool.query(
          `
            SELECT
              enabled,
              system_status AS "systemStatus"
            FROM public.supply_source_systems
            WHERE id = $1
          `,
          [sourceSystem.id],
        );
        if (
          Number(sourceSystemToggleResponse.json?.enabled ? 1 : 0) === expectedSourceSystemEnabled &&
          sourceSystemPersisted.rowCount === 1 &&
          Number(sourceSystemPersisted.rows[0]?.enabled ?? 0) === expectedSourceSystemEnabled
        ) {
          tenantSourceSystemToggleWriteVerified = true;
        }
      }
    } catch {
      tenantSourceSystemToggleWriteVerified = false;
    }

    try {
      const sourceSystemRotateResponse = await fetchJson(
        `${baseUrl}/api/workspaces/distribution-source/source-systems/${sourceSystem.id}/token/rotate`,
        {
          method: 'POST',
          headers: tenantHeaders,
        },
      );
      if (
        sourceSystemRotateResponse.status === 200 &&
        typeof sourceSystemRotateResponse.json?.callbackTokenMasked === 'string' &&
        String(sourceSystemRotateResponse.json.callbackTokenMasked) !==
          String(sourceSystem.callbackTokenMasked ?? '')
      ) {
        const sourceSystemRotatePersisted = await pool.query(
          `
            SELECT
              callback_token_masked AS "callbackTokenMasked"
            FROM public.supply_source_systems
            WHERE id = $1
          `,
          [sourceSystem.id],
        );
        if (
          sourceSystemRotatePersisted.rowCount === 1 &&
          String(sourceSystemRotatePersisted.rows[0]?.callbackTokenMasked ?? '') ===
            String(sourceSystemRotateResponse.json.callbackTokenMasked)
        ) {
          tenantSourceSystemTokenRotateWriteVerified = true;
        }
      }
    } catch {
      tenantSourceSystemTokenRotateWriteVerified = false;
    }

    let tenantSupplySourceSyncWriteVerified = false;
    let tenantSupplySourceOrderDispatchWriteVerified = false;
    try {
      await pool.query(
        `
          INSERT INTO public.workspace_modules (
            feature_key,
            feature_label,
            group_key,
            group_label,
            status_tag,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (feature_key) DO NOTHING
        `,
        [
          'distribution-supply',
          'Distribution Supply',
          'distribution',
          'Distribution',
          'Active',
          fulfillmentModuleNow,
        ],
      );
      await pool.query(
        `
          UPDATE public.supply_source_systems
          SET
            enabled = 1,
            system_status = 'online',
            order_push_enabled = 1,
            adapter_key = 'sim-own-supply',
            updated_at = $2
          WHERE id = $1
        `,
        [sourceSystem.id, fulfillmentModuleNow],
      );
      const supplyIds = await pool.query(
        `
          SELECT
            COALESCE((SELECT MAX(id) FROM public.supply_source_products), 0) + 1 AS "mappingId",
            COALESCE((SELECT MAX(id) FROM public.supply_source_orders), 0) + 1 AS "sourceOrderId"
        `,
      );
      const mappingId = Number(supplyIds.rows[0]?.mappingId ?? 1);
      const sourceOrderId = Number(supplyIds.rows[0]?.sourceOrderId ?? 1);
      await pool.query(
        `
          DELETE FROM public.supply_source_orders
          WHERE order_id = $1
        `,
        [markerOrderId],
      );
      await pool.query(
        `
          DELETE FROM public.supply_source_products
          WHERE platform_product_id = $1 OR id = $2
        `,
        [markerProductId, mappingId],
      );
      await pool.query(
        `
          INSERT INTO public.supply_source_products (
            id,
            system_id,
            external_product_id,
            external_sku,
            external_product_name,
            platform_product_id,
            platform_product_name,
            store_id,
            store_name,
            category,
            sale_price,
            source_price,
            source_stock,
            sync_status,
            enabled,
            last_sync_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, 0, 'pending', 1, $12, $12)
        `,
        [
          mappingId,
          sourceSystem.id,
          `TENANT-PG-SOURCE-${mappingId}`,
          `TENANT-PG-SOURCE-SKU-${mappingId}`,
          'Tenant PG Source Product',
          markerProductId,
          markerProductName,
          markerStoreId,
          markerStoreName,
          'Smoke Category',
          1111.11,
          fulfillmentModuleNow,
        ],
      );
      const actualMapping = await pool.query(
        `
          SELECT id
          FROM public.supply_source_products
          WHERE platform_product_id = $1
          LIMIT 1
        `,
        [markerProductId],
      );
      const actualMappingId = Number(actualMapping.rows[0]?.id ?? mappingId);
      const sourceSyncResponse = await fetchJson(
        `${baseUrl}/api/workspaces/distribution-source/source-systems/${sourceSystem.id}/sync`,
        {
          method: 'POST',
          headers: tenantJsonHeaders,
          body: JSON.stringify({ syncType: 'price' }),
        },
      );
      if (sourceSyncResponse.status === 200 && sourceSyncResponse.json?.runStatus) {
        const sourceSyncPersisted = await pool.query(
          `
            SELECT
              run_status AS "runStatus",
              success_count AS "successCount"
            FROM public.supply_source_sync_runs
            WHERE id = $1
          `,
          [sourceSyncResponse.json.id],
        );
        const mappingAfterSync = await pool.query(
          `
            SELECT
              sync_status AS "syncStatus",
              source_price AS "sourcePrice"
            FROM public.supply_source_products
            WHERE id = $1
          `,
          [actualMappingId],
        );
        tenantSupplySourceSyncWriteVerified =
          sourceSyncPersisted.rowCount === 1 &&
          ['success', 'partial'].includes(String(sourceSyncPersisted.rows[0]?.runStatus ?? '')) &&
          Number(mappingAfterSync.rows[0]?.sourcePrice ?? 0) > 0;
      }

      await pool.query(
        `
          INSERT INTO public.supply_source_orders (
            id,
            system_id,
            mapping_id,
            order_id,
            task_no,
            source_order_no,
            order_status,
            source_status,
            verification_status,
            retry_count,
            max_retry,
            failure_reason,
            result_detail,
            pushed_at,
            callback_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, NULL, 'pending_push', NULL, 'pending', 0, 2, NULL, '', NULL, NULL, $6)
        `,
        [
          sourceOrderId,
          sourceSystem.id,
          actualMappingId,
          markerOrderId,
          `TENANT-PG-SOURCE-TASK-${sourceOrderId}`,
          fulfillmentModuleNow,
        ],
      );
      const actualSourceOrder = await pool.query(
        `
          SELECT id
          FROM public.supply_source_orders
          WHERE order_id = $1
          LIMIT 1
        `,
        [markerOrderId],
      );
      const actualSourceOrderId = Number(actualSourceOrder.rows[0]?.id ?? sourceOrderId);
      const dispatchResponse = await fetchJson(
        `${baseUrl}/api/workspaces/distribution-supply/source-orders/${actualSourceOrderId}/dispatch`,
        {
          method: 'POST',
          headers: tenantHeaders,
        },
      );
      if (dispatchResponse.status !== 200 || dispatchResponse.json?.success !== true) {
        throw new Error(`Tenant supply-source dispatch request failed: ${dispatchResponse.text}`);
      }
      const sourceOrderAfterDispatch = await pool.query(
        `
          SELECT
            source_order_no AS "sourceOrderNo",
            order_status AS "orderStatus",
            pushed_at AS "pushedAt"
          FROM public.supply_source_orders
          WHERE id = $1
        `,
        [actualSourceOrderId],
      );
      const platformOrderAfterDispatch = await pool.query(
        `
          SELECT delivery_status AS "deliveryStatus"
          FROM public.orders
          WHERE id = $1
        `,
        [markerOrderId],
      );
      const sourceReconciliation = await pool.query(
        `
          SELECT reconcile_status AS "reconcileStatus"
          FROM public.supply_source_reconciliations
          WHERE reconcile_no = $1
        `,
        [`SSR-ORDER-${actualSourceOrderId}`],
      );
      tenantSupplySourceOrderDispatchWriteVerified =
        String(sourceOrderAfterDispatch.rows[0]?.orderStatus ?? '') === 'processing' &&
        String(sourceOrderAfterDispatch.rows[0]?.sourceOrderNo ?? '').startsWith('SRC-') &&
        String(platformOrderAfterDispatch.rows[0]?.deliveryStatus ?? '') === 'shipped' &&
        sourceReconciliation.rowCount === 1;
      if (!tenantSupplySourceOrderDispatchWriteVerified) {
        throw new Error(
          `Tenant supply-source dispatch persistence check failed: ${JSON.stringify({
            sourceOrder: sourceOrderAfterDispatch.rows[0] ?? null,
            platformOrder: platformOrderAfterDispatch.rows[0] ?? null,
            reconciliationCount: sourceReconciliation.rowCount,
          })}`,
        );
      }
    } catch (error) {
      tenantSupplySourceSyncWriteVerified = false;
      tenantSupplySourceOrderDispatchWriteVerified = false;
      throw error;
    }
    if (!tenantSupplySourceSyncWriteVerified) {
      throw new Error('Tenant PostgreSQL supply-source sync write was not verified.');
    }
    if (!tenantSupplySourceOrderDispatchWriteVerified) {
      throw new Error('Tenant PostgreSQL supply-source order dispatch write was not verified.');
    }

    let tenantDirectChargeQueueWriteVerified = false;
    let tenantDirectChargeManualReviewQueueWriteVerified = false;
    let tenantCardFulfillmentQueueWriteVerified = false;
    let tenantCardOutboundResendQueueWriteVerified = false;
    try {
      await pool.query(
        `
          INSERT INTO public.workspace_modules (
            feature_key,
            feature_label,
            group_key,
            group_label,
            status_tag,
            updated_at
          )
          VALUES
            ($1, $2, $3, $4, $5, $6),
            ($7, $8, $3, $4, $5, $6)
          ON CONFLICT (feature_key) DO NOTHING
        `,
        [
          'card-delivery',
          'Card Delivery',
          'distribution',
          'Distribution',
          'Active',
          fulfillmentModuleNow,
          'card-records',
          'Card Records',
        ],
      );

      const executionIds = await pool.query(
        `
          SELECT
            COALESCE((SELECT MAX(id) FROM public.products), 0) + 1 AS "directProductId",
            COALESCE((SELECT MAX(id) FROM public.products), 0) + 2 AS "cardProductId",
            COALESCE((SELECT MAX(id) FROM public.orders), 0) + 1 AS "directOrderId",
            COALESCE((SELECT MAX(id) FROM public.orders), 0) + 2 AS "cardOrderId",
            COALESCE((SELECT MAX(id) FROM public.orders), 0) + 3 AS "cardResendOrderId",
            COALESCE((SELECT MAX(id) FROM public.direct_charge_suppliers), 0) + 1 AS "directSupplierId",
            COALESCE((SELECT MAX(id) FROM public.direct_charge_items), 0) + 1 AS "directItemId",
            COALESCE((SELECT MAX(id) FROM public.direct_charge_jobs), 0) + 1 AS "directJobId",
            COALESCE((SELECT MAX(id) FROM public.card_types), 0) + 1 AS "cardTypeId",
            COALESCE((SELECT MAX(id) FROM public.card_delivery_items), 0) + 1 AS "cardDeliveryItemId",
            COALESCE((SELECT MAX(id) FROM public.card_inventory_items), 0) + 1 AS "cardInventoryItemId",
            COALESCE((SELECT MAX(id) FROM public.card_outbound_records), 0) + 1 AS "cardOutboundRecordId"
        `,
      );
      const directProductId = Number(executionIds.rows[0]?.directProductId ?? 1);
      const cardProductId = Number(executionIds.rows[0]?.cardProductId ?? directProductId + 1);
      const directOrderId = Number(executionIds.rows[0]?.directOrderId ?? 1);
      const cardOrderId = Number(executionIds.rows[0]?.cardOrderId ?? directOrderId + 1);
      const cardResendOrderId = Number(executionIds.rows[0]?.cardResendOrderId ?? cardOrderId + 1);
      const directSupplierId = Number(executionIds.rows[0]?.directSupplierId ?? 1);
      const directItemId = Number(executionIds.rows[0]?.directItemId ?? 1);
      const directJobId = Number(executionIds.rows[0]?.directJobId ?? 1);
      const cardTypeId = Number(executionIds.rows[0]?.cardTypeId ?? 1);
      const cardDeliveryItemId = Number(executionIds.rows[0]?.cardDeliveryItemId ?? 1);
      const cardInventoryItemId = Number(executionIds.rows[0]?.cardInventoryItemId ?? 1);
      const cardOutboundRecordId = Number(executionIds.rows[0]?.cardOutboundRecordId ?? 1);

      await pool.query(
        `
          INSERT INTO public.products (id, store_id, sku, name, category, price, cost, stock)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8),
            ($9, $2, $10, $11, $5, $12, $13, $14)
        `,
        [
          directProductId,
          markerStoreId,
          `tenant-pg-direct-sku-${directProductId}`,
          'Tenant PG Direct Product',
          'Smoke Category',
          50,
          10,
          10,
          cardProductId,
          `tenant-pg-card-sku-${cardProductId}`,
          'Tenant PG Card Product',
          88,
          20,
          10,
        ],
      );

      await pool.query(
        `
          INSERT INTO public.orders (
            id,
            order_no,
            store_id,
            product_id,
            customer_id,
            source,
            quantity,
            paid_amount,
            discount_amount,
            order_status,
            main_status,
            payment_status,
            delivery_status,
            after_sale_status,
            refund_amount,
            paid_at,
            shipped_at,
            completed_at,
            delivery_hours,
            is_new_customer,
            buyer_note,
            seller_remark,
            created_at,
            updated_at
          )
          VALUES
            ($1, $2, $3, $4, $5, 'tenant-pg-direct-charge', 1, 50, 0, 'pending_shipment', 'processing', 'paid', 'pending', 'none', 0, $6, NULL, NULL, 0, 0, '', '', $6, $6),
            ($7, $8, $3, $9, $5, 'tenant-pg-card-worker', 1, 88, 0, 'pending_shipment', 'processing', 'paid', 'pending', 'none', 0, $6, NULL, NULL, 0, 0, '', '', $6, $6),
            ($10, $11, $3, $9, $5, 'tenant-pg-card-resend', 1, 88, 0, 'shipped', 'fulfilled', 'paid', 'delivered', 'none', 0, $6, $6, $6, 1, 0, '', '', $6, $6)
        `,
        [
          directOrderId,
          `TENANT-PG-DIRECT-${directOrderId}`,
          markerStoreId,
          directProductId,
          markerCustomerId,
          fulfillmentModuleNow,
          cardOrderId,
          `TENANT-PG-CARD-${cardOrderId}`,
          cardProductId,
          cardResendOrderId,
          `TENANT-PG-CARD-RESENT-${cardResendOrderId}`,
        ],
      );

      await pool.query(
        `
          INSERT INTO public.direct_charge_suppliers (
            id,
            supplier_key,
            supplier_name,
            adapter_key,
            account_name,
            endpoint_url,
            callback_token,
            callback_token_masked,
            enabled,
            supplier_status,
            balance,
            success_rate,
            timeout_minutes,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'sim-topup', $3, 'https://tenant-pg-direct.example.com', 'tenant-pg-direct-token', 'tpd***ken', 1, 'online', 5000, 99, 15, $4, $4)
        `,
        [directSupplierId, `tenant-pg-direct-${directSupplierId}`, 'Tenant PG Direct Supplier', fulfillmentModuleNow],
      );
      await pool.query(
        `
          INSERT INTO public.direct_charge_items (
            id,
            supplier_id,
            product_id,
            product_title,
            category,
            store_name,
            target_type,
            zone_required,
            face_value,
            enabled,
            status,
            updated_at
          )
          VALUES ($1, $2, $3, $4, 'Smoke Category', $5, 'mobile', 0, 50, 1, '销售中', $6)
        `,
        [directItemId, directSupplierId, directProductId, 'Tenant PG Direct Product', markerStoreName, fulfillmentModuleNow],
      );
      await pool.query(
        `
          INSERT INTO public.direct_charge_jobs (
            id,
            order_id,
            supplier_id,
            item_id,
            task_no,
            supplier_order_no,
            adapter_key,
            target_account,
            target_zone,
            face_value,
            task_status,
            supplier_status,
            callback_status,
            verification_status,
            retry_count,
            max_retry,
            error_message,
            result_detail,
            created_at,
            updated_at,
            last_dispatch_at,
            last_callback_at,
            timeout_at,
            manual_reason
          )
          VALUES (
            $1, $2, $3, $4, $5, NULL, 'sim-topup', '13800138000', NULL, 50, 'failed', 'FAILED', 'pending', 'pending', 0, 2, 'seeded failure', 'seeded failure', $6, $6, NULL, NULL, NULL, NULL
          )
        `,
        [directJobId, directOrderId, directSupplierId, directItemId, `TENANT-PG-DIRECT-TASK-${directJobId}`, fulfillmentModuleNow],
      );

      const directChargeDispatchResponse = await fetchJson(
        `${baseUrl}/api/workspaces/distribution-supply/direct-charge-jobs/${directJobId}/dispatch`,
        {
          method: 'POST',
          headers: tenantHeaders,
        },
      );
      if (directChargeDispatchResponse.status !== 200) {
        throw new Error(`Tenant direct-charge queue dispatch failed: ${directChargeDispatchResponse.text}`);
      }
      const directChargePersisted = await pool.query(
        `
          SELECT
            task_status AS "taskStatus",
            callback_status AS "callbackStatus",
            verification_status AS "verificationStatus",
            result_detail AS "resultDetail",
            manual_reason AS "manualReason"
          FROM public.direct_charge_jobs
          WHERE id = $1
        `,
        [directJobId],
      );
      tenantDirectChargeQueueWriteVerified =
        directChargePersisted.rowCount === 1 &&
        String(directChargePersisted.rows[0]?.taskStatus ?? '') === 'pending_dispatch' &&
        String(directChargePersisted.rows[0]?.callbackStatus ?? '') === 'pending' &&
        String(directChargePersisted.rows[0]?.verificationStatus ?? '') === 'pending' &&
        directChargeDispatchResponse.json?.success === true &&
        directChargeDispatchResponse.json?.accepted === true &&
        directChargeDispatchResponse.json?.queued === true;
      if (!tenantDirectChargeQueueWriteVerified) {
        throw new Error(
          `Tenant direct-charge queue dispatch persistence check failed: ${JSON.stringify({
            response: directChargeDispatchResponse.json,
            persisted: directChargePersisted.rows[0] ?? null,
          })}`,
        );
      }

      const directChargeManualReviewResponse = await fetchJson(
        `${baseUrl}/api/workspaces/distribution-supply/direct-charge-jobs/${directJobId}/manual-review`,
        {
          method: 'POST',
          headers: tenantJsonHeaders,
          body: JSON.stringify({ reason: 'tenant-pg-direct-manual-review' }),
        },
      );
      if (directChargeManualReviewResponse.status !== 200) {
        throw new Error(`Tenant direct-charge manual-review queue failed: ${directChargeManualReviewResponse.text}`);
      }
      const directChargeManualPersisted = await pool.query(
        `
          SELECT
            error_message AS "errorMessage",
            result_detail AS "resultDetail",
            manual_reason AS "manualReason"
          FROM public.direct_charge_jobs
          WHERE id = $1
        `,
        [directJobId],
      );
      tenantDirectChargeManualReviewQueueWriteVerified =
        directChargeManualPersisted.rowCount === 1 &&
        String(directChargeManualPersisted.rows[0]?.manualReason ?? '') === 'tenant-pg-direct-manual-review' &&
        directChargeManualReviewResponse.json?.success === true &&
        directChargeManualReviewResponse.json?.accepted === true &&
        directChargeManualReviewResponse.json?.queued === true;
      if (!tenantDirectChargeManualReviewQueueWriteVerified) {
        throw new Error(
          `Tenant direct-charge manual-review queue persistence check failed: ${JSON.stringify({
            response: directChargeManualReviewResponse.json,
            persisted: directChargeManualPersisted.rows[0] ?? null,
          })}`,
        );
      }

      await pool.query(
        `
          INSERT INTO public.card_types (
            id,
            type_name,
            unsold_count,
            sold_count,
            total_stock,
            delivery_channel,
            inventory_cost,
            average_price,
            card_prefix,
            password_prefix,
            separator_text,
            template_count,
            is_deleted,
            created_at,
            updated_at
          )
          VALUES ($1, $2, 1, 0, 1, '站内消息', 20, 88, 'CARD', 'PWD', '-', 1, 0, $3, $3)
        `,
        [cardTypeId, 'Tenant PG Card Type', fulfillmentModuleNow],
      );
      await pool.query(
        `
          INSERT INTO public.card_delivery_items (
            id,
            card_type_id,
            product_id,
            product_title,
            sale_price,
            category,
            store_name,
            content_mode,
            delivery_policy,
            enabled,
            status,
            updated_at
          )
          VALUES ($1, $2, $3, $4, 88, 'Smoke Category', $5, 'template', 'auto', 1, '销售中', $6)
        `,
        [cardDeliveryItemId, cardTypeId, cardProductId, 'Tenant PG Card Product', markerStoreName, fulfillmentModuleNow],
      );
      await pool.query(
        `
          INSERT INTO public.card_inventory_items (
            id,
            card_type_id,
            batch_id,
            card_no,
            card_secret,
            card_masked,
            item_status,
            locked_order_id,
            locked_at,
            outbound_record_id,
            disabled_reason,
            imported_at,
            updated_at,
            last_used_at
          )
          VALUES ($1, $2, NULL, $3, $4, $5, 'sold', $6, $7, $8, NULL, $7, $7, $7)
        `,
        [
          cardInventoryItemId,
          cardTypeId,
          `TENANTCARD${cardInventoryItemId}`,
          `TENANTPWD${cardInventoryItemId}`,
          `TEN***${String(cardInventoryItemId).padStart(4, '0')}`,
          cardResendOrderId,
          fulfillmentModuleNow,
          cardOutboundRecordId,
        ],
      );
      await pool.query(
        `
          INSERT INTO public.card_outbound_records (
            id,
            order_id,
            card_type_id,
            inventory_item_id,
            outbound_no,
            outbound_status,
            attempt_no,
            parent_outbound_id,
            template_id,
            message_content,
            send_channel,
            reason,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, 'sent', 1, NULL, NULL, 'tenant-pg-card-seed', '站内消息', NULL, $6, $6)
        `,
        [cardOutboundRecordId, cardResendOrderId, cardTypeId, cardInventoryItemId, `TENANT-PG-OUT-${cardOutboundRecordId}`, fulfillmentModuleNow],
      );

      const cardFulfillmentQueueResponse = await fetchJson(
        `${baseUrl}/api/workspaces/card-delivery/orders/${cardOrderId}/fulfill`,
        {
          method: 'POST',
          headers: tenantHeaders,
        },
      );
      if (cardFulfillmentQueueResponse.status !== 200) {
        throw new Error(`Tenant card fulfillment queue failed: ${cardFulfillmentQueueResponse.text}`);
      }
      const cardFulfillmentPersisted = await pool.query(
        `
          SELECT
            id,
            job_status AS "jobStatus",
            related_outbound_record_id AS "relatedOutboundRecordId"
          FROM public.card_delivery_jobs
          WHERE order_id = $1
            AND job_type = 'auto_fulfill'
          ORDER BY id DESC
          LIMIT 1
        `,
        [cardOrderId],
      );
      tenantCardFulfillmentQueueWriteVerified =
        cardFulfillmentPersisted.rowCount === 1 &&
        String(cardFulfillmentPersisted.rows[0]?.jobStatus ?? '') === 'pending' &&
        cardFulfillmentQueueResponse.json?.success === true &&
        cardFulfillmentQueueResponse.json?.accepted === true &&
        cardFulfillmentQueueResponse.json?.queued === true;
      if (!tenantCardFulfillmentQueueWriteVerified) {
        throw new Error(
          `Tenant card fulfillment queue persistence check failed: ${JSON.stringify({
            response: cardFulfillmentQueueResponse.json,
            persisted: cardFulfillmentPersisted.rows[0] ?? null,
          })}`,
        );
      }

      const cardOutboundResendResponse = await fetchJson(
        `${baseUrl}/api/workspaces/card-records/outbound-records/${cardOutboundRecordId}/resend`,
        {
          method: 'POST',
          headers: tenantHeaders,
        },
      );
      if (cardOutboundResendResponse.status !== 200) {
        throw new Error(`Tenant card outbound resend queue failed: ${cardOutboundResendResponse.text}`);
      }
      const cardOutboundResendPersisted = await pool.query(
        `
          SELECT
            id,
            job_status AS "jobStatus",
            related_outbound_record_id AS "relatedOutboundRecordId"
          FROM public.card_delivery_jobs
          WHERE order_id = $1
            AND job_type = 'manual_resend'
          ORDER BY id DESC
          LIMIT 1
        `,
        [cardResendOrderId],
      );
      tenantCardOutboundResendQueueWriteVerified =
        cardOutboundResendPersisted.rowCount === 1 &&
        String(cardOutboundResendPersisted.rows[0]?.jobStatus ?? '') === 'pending' &&
        Number(cardOutboundResendPersisted.rows[0]?.relatedOutboundRecordId ?? 0) === cardOutboundRecordId &&
        cardOutboundResendResponse.json?.success === true &&
        cardOutboundResendResponse.json?.accepted === true &&
        cardOutboundResendResponse.json?.queued === true;
      if (!tenantCardOutboundResendQueueWriteVerified) {
        throw new Error(
          `Tenant card outbound resend queue persistence check failed: ${JSON.stringify({
            response: cardOutboundResendResponse.json,
            persisted: cardOutboundResendPersisted.rows[0] ?? null,
          })}`,
        );
      }
    } catch (error) {
      tenantDirectChargeQueueWriteVerified = false;
      tenantDirectChargeManualReviewQueueWriteVerified = false;
      tenantCardFulfillmentQueueWriteVerified = false;
      tenantCardOutboundResendQueueWriteVerified = false;
      throw error;
    }
    if (!tenantDirectChargeQueueWriteVerified) {
      throw new Error('Tenant PostgreSQL direct-charge worker queue write was not verified.');
    }
    if (!tenantDirectChargeManualReviewQueueWriteVerified) {
      throw new Error('Tenant PostgreSQL direct-charge manual-review queue write was not verified.');
    }
    if (!tenantCardFulfillmentQueueWriteVerified) {
      throw new Error('Tenant PostgreSQL card fulfillment worker queue write was not verified.');
    }
    if (!tenantCardOutboundResendQueueWriteVerified) {
      throw new Error('Tenant PostgreSQL card outbound resend worker queue write was not verified.');
    }

    const aiSettingsWriteResponse = await fetchJson(`${baseUrl}/api/workspaces/ai-service/settings`, {
      method: 'POST',
      headers: tenantJsonHeaders,
      body: JSON.stringify({
        aiEnabled: true,
        autoReplyEnabled: false,
        faqEnabled: true,
        orderQueryEnabled: true,
        afterSaleSuggestionEnabled: false,
        highRiskManualOnly: true,
        boundaryNote: 'tenant-pg-ai-boundary',
        sensitiveWordsText: 'refund,manual',
      }),
    });
    if (aiSettingsWriteResponse.status !== 200) {
      throw new Error(`Tenant AI service settings write failed: ${aiSettingsWriteResponse.text}`);
    }
    const aiSettingsPersisted = await pool.query(
      `
        SELECT
          ai_enabled AS "aiEnabled",
          auto_reply_enabled AS "autoReplyEnabled",
          faq_enabled AS "faqEnabled",
          order_query_enabled AS "orderQueryEnabled",
          after_sale_suggestion_enabled AS "afterSaleSuggestionEnabled",
          high_risk_manual_only AS "highRiskManualOnly",
          boundary_note AS "boundaryNote",
          sensitive_words_text AS "sensitiveWordsText"
        FROM public.ai_service_settings
        WHERE id = 1
      `,
    );
    const tenantAiServiceSettingsWriteVerified =
      aiSettingsPersisted.rowCount === 1 &&
      Number(aiSettingsPersisted.rows[0]?.aiEnabled ?? 0) === 1 &&
      Number(aiSettingsPersisted.rows[0]?.autoReplyEnabled ?? 1) === 0 &&
      Number(aiSettingsPersisted.rows[0]?.faqEnabled ?? 0) === 1 &&
      Number(aiSettingsPersisted.rows[0]?.orderQueryEnabled ?? 0) === 1 &&
      Number(aiSettingsPersisted.rows[0]?.afterSaleSuggestionEnabled ?? 1) === 0 &&
      Number(aiSettingsPersisted.rows[0]?.highRiskManualOnly ?? 0) === 1 &&
      String(aiSettingsPersisted.rows[0]?.boundaryNote ?? '') === 'tenant-pg-ai-boundary' &&
      String(aiSettingsPersisted.rows[0]?.sensitiveWordsText ?? '') === 'refund,manual';

    const aiKnowledgeItemResult = await pool.query(
      `
        SELECT id, enabled
        FROM public.ai_service_knowledge_items
        ORDER BY id
        LIMIT 1
      `,
    );
    const aiKnowledgeItem = aiKnowledgeItemResult.rows[0];
    const aiKnowledgeToggleResponse = await fetchJson(
      `${baseUrl}/api/workspaces/ai-service/knowledge-items/${aiKnowledgeItem.id}/enabled`,
      {
        method: 'POST',
        headers: tenantJsonHeaders,
        body: JSON.stringify({ enabled: Number(aiKnowledgeItem.enabled ?? 0) === 1 ? false : true }),
      },
    );
    if (aiKnowledgeToggleResponse.status !== 200) {
      throw new Error(`Tenant AI knowledge toggle failed: ${aiKnowledgeToggleResponse.text}`);
    }
    const aiKnowledgePersisted = await pool.query(
      `
        SELECT enabled
        FROM public.ai_service_knowledge_items
        WHERE id = $1
      `,
      [aiKnowledgeItem.id],
    );
    const tenantAiServiceKnowledgeToggleWriteVerified =
      aiKnowledgePersisted.rowCount === 1 &&
      Number(aiKnowledgePersisted.rows[0]?.enabled ?? 0) ===
        (Number(aiKnowledgeItem.enabled ?? 0) === 1 ? 0 : 1);

    const aiTemplateResult = await pool.query(
      `
        SELECT id, enabled
        FROM public.ai_service_reply_templates
        ORDER BY id
        LIMIT 1
      `,
    );
    const aiTemplate = aiTemplateResult.rows[0];
    const aiTemplateToggleResponse = await fetchJson(
      `${baseUrl}/api/workspaces/ai-service/reply-templates/${aiTemplate.id}/enabled`,
      {
        method: 'POST',
        headers: tenantJsonHeaders,
        body: JSON.stringify({ enabled: Number(aiTemplate.enabled ?? 0) === 1 ? false : true }),
      },
    );
    if (aiTemplateToggleResponse.status !== 200) {
      throw new Error(`Tenant AI reply template toggle failed: ${aiTemplateToggleResponse.text}`);
    }
    const aiTemplatePersisted = await pool.query(
      `
        SELECT enabled
        FROM public.ai_service_reply_templates
        WHERE id = $1
      `,
      [aiTemplate.id],
    );
    const tenantAiServiceReplyTemplateToggleWriteVerified =
      aiTemplatePersisted.rowCount === 1 &&
      Number(aiTemplatePersisted.rows[0]?.enabled ?? 0) ===
        (Number(aiTemplate.enabled ?? 0) === 1 ? 0 : 1);

    const aiServiceDetailResponse = await fetchJson(`${baseUrl}/api/workspaces/ai-service/detail`, {
      headers: tenantHeaders,
    });
    if (aiServiceDetailResponse.status !== 200) {
      throw new Error(`Tenant AI service detail failed: ${aiServiceDetailResponse.text}`);
    }
    const aiServiceDetail = aiServiceDetailResponse.json ?? {};
    const tenantAiServiceDetailVerified =
      String(aiServiceDetail?.settings?.boundaryNote ?? '') === 'tenant-pg-ai-boundary' &&
      Array.isArray(aiServiceDetail?.conversations) &&
      Array.isArray(aiServiceDetail?.knowledgeItems) &&
      Array.isArray(aiServiceDetail?.replyTemplates);

    let takeoverConversationId = Number(
      aiServiceDetail?.conversations?.find?.((item) => Number(item?.id ?? 0) > 0)?.id ?? 0,
    );
    if (takeoverConversationId <= 0) {
      const aiConversationIdResult = await pool.query(
        `SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM public.ai_service_conversations`,
      );
      takeoverConversationId = Number(aiConversationIdResult.rows[0]?.nextId ?? 1);
      const takeoverSeedNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
      await pool.query(
        `
          INSERT INTO public.ai_service_conversations (
            id,
            session_no,
            channel,
            source,
            customer_id,
            customer_name,
            store_id,
            order_id,
            case_id,
            topic,
            latest_user_intent,
            item_main_pic,
            conversation_status,
            ai_status,
            risk_level,
            priority,
            unread_count,
            assigned_user_id,
            boundary_label,
            tags_text,
            last_message_at,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            '闲鱼 IM',
            'tenant_pg_smoke',
            $3,
            $4,
            $5,
            NULL,
            NULL,
            'Tenant PG AI takeover smoke',
            '需要人工接管',
            NULL,
            'open',
            'ready',
            'low',
            'medium',
            1,
            NULL,
            '',
            'tenant-pg-smoke',
            $6,
            $6,
            $6
          )
        `,
        [
          takeoverConversationId,
          `tenant-pg-ai-conversation-${Date.now()}`,
          markerCustomerId,
          'Tenant PG Marker Customer',
          markerStoreId,
          takeoverSeedNow,
        ],
      );
    }
    let tenantAiServiceTakeoverWriteVerified = false;
    if (takeoverConversationId > 0) {
      const takeoverCountBefore = await pool.query(
        `
          SELECT COUNT(*)::int AS count
          FROM public.ai_service_takeovers
          WHERE conversation_id = $1
        `,
        [takeoverConversationId],
      );
      const takeoverResponse = await fetchJson(
        `${baseUrl}/api/workspaces/ai-service/conversations/${takeoverConversationId}/takeover`,
        {
          method: 'POST',
          headers: tenantJsonHeaders,
          body: JSON.stringify({
            action: 'takeover',
            note: 'tenant pg smoke takeover',
          }),
        },
      );
      if (
        takeoverResponse.status === 200 &&
        String(takeoverResponse.json?.conversationStatus ?? '') === 'manual_active' &&
        String(takeoverResponse.json?.aiStatus ?? '') === 'manual_only'
      ) {
        const takeoverConversationPersisted = await pool.query(
          `
            SELECT
              conversation_status AS "conversationStatus",
              ai_status AS "aiStatus",
              assigned_user_id AS "assignedUserId",
              boundary_label AS "boundaryLabel"
            FROM public.ai_service_conversations
            WHERE id = $1
          `,
          [takeoverConversationId],
        );
        const takeoverCountAfter = await pool.query(
          `
            SELECT COUNT(*)::int AS count
            FROM public.ai_service_takeovers
            WHERE conversation_id = $1
          `,
          [takeoverConversationId],
        );
        tenantAiServiceTakeoverWriteVerified =
          takeoverConversationPersisted.rowCount === 1 &&
          String(takeoverConversationPersisted.rows[0]?.conversationStatus ?? '') === 'manual_active' &&
          String(takeoverConversationPersisted.rows[0]?.aiStatus ?? '') === 'manual_only' &&
          Number(takeoverConversationPersisted.rows[0]?.assignedUserId ?? 0) > 0 &&
          String(takeoverConversationPersisted.rows[0]?.boundaryLabel ?? '').trim().length > 0 &&
          Number(takeoverCountAfter.rows[0]?.count ?? 0) >=
            Number(takeoverCountBefore.rows[0]?.count ?? 0) + 1;
      }
    }

    const fundModuleNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
    for (const [featureKey, featureLabel] of [
      ['fund-withdrawals', 'Withdrawals'],
      ['fund-accounts', 'Fund Accounts'],
      ['fund-bills', 'Fund Bills'],
    ]) {
      await pool.query(
        `
          INSERT INTO public.workspace_modules (
            feature_key,
            feature_label,
            group_key,
            group_label,
            status_tag,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (feature_key) DO NOTHING
        `,
        [featureKey, featureLabel, 'fund', 'Fund', 'Active', fundModuleNow],
      );
    }

    const fundAccountResult = await pool.query(
      `
        SELECT
          id,
          available_balance AS "availableBalance",
          pending_withdrawal AS "pendingWithdrawal",
          total_paid_out AS "totalPaidOut"
        FROM public.fund_accounts
        ORDER BY id
        LIMIT 1
      `,
    );
    let fundAccount = fundAccountResult.rows[0];
    if (!fundAccount) {
      await pool.query(
        `
          INSERT INTO public.fund_accounts (
            id,
            account_name,
            available_balance,
            pending_withdrawal,
            frozen_balance,
            deposit_balance,
            total_recharged,
            total_paid_out,
            status,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [1, 'Tenant PG Smoke Account', 5000, 0, 0, 0, 5000, 0, 'active', fundModuleNow],
      );
      fundAccount = {
        id: 1,
        availableBalance: 5000,
        pendingWithdrawal: 0,
        totalPaidOut: 0,
      };
    }

    const fundAuditLogBefore = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM public.audit_logs
        WHERE action IN ('withdrawal_created', 'withdrawal_reviewed', 'reconciliation_updated')
      `,
    );
    const withdrawalCreateResponse = await fetchJson(`${baseUrl}/api/workspaces/fund-withdrawals/withdrawals`, {
      method: 'POST',
      headers: tenantJsonHeaders,
      body: JSON.stringify({
        amount: 120,
        method: 'bank_transfer',
        receivingAccount: 'tenant-pg-smoke-bank',
      }),
    });
    if (withdrawalCreateResponse.status !== 200 || withdrawalCreateResponse.json?.status !== 'pending') {
      throw new Error(`Tenant fund withdrawal create failed: ${withdrawalCreateResponse.text}`);
    }

    const createdWithdrawalResult = await pool.query(
      `
        SELECT
          id,
          withdrawal_no AS "withdrawalNo",
          amount,
          fee,
          arrival_amount AS "arrivalAmount",
          status
        FROM public.fund_withdrawals
        ORDER BY id DESC
        LIMIT 1
      `,
    );
    const createdWithdrawal = createdWithdrawalResult.rows[0];
    if (!createdWithdrawal || String(createdWithdrawal.status ?? '') !== 'pending') {
      throw new Error('Tenant PostgreSQL withdrawal row was not persisted in pending status.');
    }

    const withdrawalReconciliationResult = await pool.query(
      `
        SELECT
          id,
          platform_amount AS "platformAmount",
          ledger_amount AS "ledgerAmount",
          reconcile_status AS "reconcileStatus",
          manual_status AS "manualStatus"
        FROM public.fund_reconciliations
        WHERE ref_type = 'withdrawal' AND ref_id = $1
      `,
      [createdWithdrawal.id],
    );
    const feeReconciliationResult = await pool.query(
      `
        SELECT id
        FROM public.fund_reconciliations
        WHERE ref_type = 'withdrawal_fee' AND ref_id = $1
      `,
      [createdWithdrawal.id],
    );
    const accountAfterCreateResult = await pool.query(
      `
        SELECT
          available_balance AS "availableBalance",
          pending_withdrawal AS "pendingWithdrawal",
          total_paid_out AS "totalPaidOut"
        FROM public.fund_accounts
        WHERE id = $1
      `,
      [fundAccount.id],
    );
    const accountAfterCreate = accountAfterCreateResult.rows[0];
    if (!withdrawalReconciliationResult.rows[0] || feeReconciliationResult.rowCount !== 1) {
      throw new Error('Tenant PostgreSQL withdrawal reconciliation rows were not created.');
    }
    if (
      Number(accountAfterCreate?.availableBalance ?? 0) >= Number(fundAccount.availableBalance ?? 0) ||
      Number(accountAfterCreate?.pendingWithdrawal ?? 0) <= Number(fundAccount.pendingWithdrawal ?? 0)
    ) {
      throw new Error('Tenant PostgreSQL fund account balances did not move after withdrawal create.');
    }
    const tenantFundWithdrawalWriteVerified = true;

    const withdrawalStatusResponse = await fetchJson(
      `${baseUrl}/api/workspaces/fund-withdrawals/withdrawals/${createdWithdrawal.id}/status`,
      {
        method: 'POST',
        headers: tenantJsonHeaders,
        body: JSON.stringify({ status: 'paid' }),
      },
    );
    if (withdrawalStatusResponse.status !== 200 || withdrawalStatusResponse.json?.status !== 'paid') {
      throw new Error(`Tenant withdrawal status update failed: ${withdrawalStatusResponse.text}`);
    }

    const withdrawalAfterStatusResult = await pool.query(
      `
        SELECT
          status,
          arrival_amount AS "arrivalAmount",
          fee
        FROM public.fund_withdrawals
        WHERE id = $1
      `,
      [createdWithdrawal.id],
    );
    const accountAfterStatusResult = await pool.query(
      `
        SELECT
          pending_withdrawal AS "pendingWithdrawal",
          total_paid_out AS "totalPaidOut"
        FROM public.fund_accounts
        WHERE id = $1
      `,
      [fundAccount.id],
    );
    const withdrawalReconciliationAfterStatus = await pool.query(
      `
        SELECT
          platform_amount AS "platformAmount",
          reconcile_status AS "reconcileStatus"
        FROM public.fund_reconciliations
        WHERE ref_type = 'withdrawal' AND ref_id = $1
      `,
      [createdWithdrawal.id],
    );
    const withdrawalAfterStatus = withdrawalAfterStatusResult.rows[0];
    const accountAfterStatus = accountAfterStatusResult.rows[0];
    if (
      String(withdrawalAfterStatus?.status ?? '') !== 'paid' ||
      Number(accountAfterStatus?.pendingWithdrawal ?? 0) !== 0 ||
      Number(accountAfterStatus?.totalPaidOut ?? 0) <= Number(accountAfterCreate?.totalPaidOut ?? 0) ||
      Number(withdrawalReconciliationAfterStatus.rows[0]?.platformAmount ?? 0) <= 0
    ) {
      throw new Error('Tenant PostgreSQL withdrawal paid flow did not persist expected account or reconciliation changes.');
    }
    const tenantFundWithdrawalStatusWriteVerified = true;

    const withdrawalReconciliationRow = withdrawalReconciliationResult.rows[0];
    const reconciliationStatusResponse = await fetchJson(
      `${baseUrl}/api/workspaces/fund-accounts/reconciliations/${withdrawalReconciliationRow.id}/status`,
      {
        method: 'POST',
        headers: tenantJsonHeaders,
        body: JSON.stringify({
          status: 'reviewed',
          note: 'tenant pg smoke reviewed',
        }),
      },
    );
    if (
      reconciliationStatusResponse.status !== 200 ||
      reconciliationStatusResponse.json?.status !== 'reviewed'
    ) {
      throw new Error(`Tenant reconciliation status update failed: ${reconciliationStatusResponse.text}`);
    }

    const reconciliationAfterUpdateResult = await pool.query(
      `
        SELECT
          reconcile_status AS "reconcileStatus",
          manual_status AS "manualStatus",
          note
        FROM public.fund_reconciliations
        WHERE id = $1
      `,
      [withdrawalReconciliationRow.id],
    );
    const fundAuditLogAfter = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM public.audit_logs
        WHERE action IN ('withdrawal_created', 'withdrawal_reviewed', 'reconciliation_updated')
      `,
    );
    const reconciliationAfterUpdate = reconciliationAfterUpdateResult.rows[0];
    if (
      String(reconciliationAfterUpdate?.reconcileStatus ?? '') !== 'reviewed' ||
      Number(reconciliationAfterUpdate?.manualStatus ?? 0) !== 1 ||
      String(reconciliationAfterUpdate?.note ?? '') !== 'tenant pg smoke reviewed'
    ) {
      throw new Error('Tenant PostgreSQL reconciliation update did not persist reviewed state.');
    }
    if (
      Number(fundAuditLogAfter.rows[0]?.count ?? 0) <
      Number(fundAuditLogBefore.rows[0]?.count ?? 0) + 3
    ) {
      throw new Error('Tenant PostgreSQL fund audit log count did not increase as expected.');
    }
    const tenantFundReconciliationWriteVerified = true;

    const userIdResult = await pool.query(`SELECT id FROM public.users ORDER BY id ASC LIMIT 1`);
    const openPlatformUserId = Number(userIdResult.rows[0]?.id ?? 1);
    const openPlatformNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const openPlatformAppSecret = 'tenant-pg-open-secret-20260420';
    await pool.query(
      `
        INSERT INTO public.open_platform_settings (
          id,
          webhook_base_url,
          notify_email,
          published_version,
          default_rate_limit_per_minute,
          signature_ttl_seconds,
          whitelist_enforced,
          created_at,
          updated_at,
          updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
          webhook_base_url = EXCLUDED.webhook_base_url,
          notify_email = EXCLUDED.notify_email,
          published_version = EXCLUDED.published_version,
          default_rate_limit_per_minute = EXCLUDED.default_rate_limit_per_minute,
          signature_ttl_seconds = EXCLUDED.signature_ttl_seconds,
          whitelist_enforced = EXCLUDED.whitelist_enforced,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by
      `,
      [
        1,
        'https://tenant-pg-open.example.com',
        'tenant-pg-open@example.com',
        'tenant-pg-v1',
        321,
        654,
        1,
        openPlatformNow,
        openPlatformUserId,
      ],
    );
    await pool.query(
      `
        INSERT INTO public.secure_settings (
          key,
          description,
          value_encrypted,
          value_masked,
          updated_by,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (key) DO UPDATE SET
          description = EXCLUDED.description,
          value_encrypted = EXCLUDED.value_encrypted,
          value_masked = EXCLUDED.value_masked,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at
      `,
      [
        'tenant-pg-open-secret',
        'Tenant PG open-platform smoke secret',
        encryptSecretForSmoke(openPlatformAppSecret, process.env.APP_CONFIG_CIPHER_SECRET ?? 'saas-tenant-pg-smoke-config-secret-20260420'),
        'pg-only-mask',
        openPlatformUserId,
        openPlatformNow,
      ],
    );
    const openPlatformAppIdResult = await pool.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM public.open_platform_apps`,
    );
    const openPlatformDocIdResult = await pool.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM public.open_platform_docs`,
    );
    const openPlatformRuleIdResult = await pool.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM public.open_platform_whitelist_rules`,
    );
    const openPlatformCallLogIdResult = await pool.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM public.open_platform_call_logs`,
    );
    await pool.query(
      `
        INSERT INTO public.open_platform_apps (
          id,
          app_key,
          app_name,
          owner_name,
          contact_name,
          callback_url,
          status,
          scopes_text,
          secret_setting_key,
          rate_limit_per_minute,
          last_called_at,
          created_at,
          updated_at,
          updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10, $11, $11, $12)
        ON CONFLICT (app_key) DO UPDATE SET
          app_name = EXCLUDED.app_name,
          owner_name = EXCLUDED.owner_name,
          contact_name = EXCLUDED.contact_name,
          callback_url = EXCLUDED.callback_url,
          status = EXCLUDED.status,
          scopes_text = EXCLUDED.scopes_text,
          secret_setting_key = EXCLUDED.secret_setting_key,
          rate_limit_per_minute = EXCLUDED.rate_limit_per_minute,
          last_called_at = EXCLUDED.last_called_at,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by
      `,
      [
        Number(openPlatformAppIdResult.rows[0]?.nextId ?? 1),
        'tenant-pg-open-app',
        'Tenant PG Open App',
        'Tenant PG Owner',
        'tenant-pg-open@example.com',
        'https://tenant-pg-open.example.com/callback',
        'dashboard.read,orders.read',
        'tenant-pg-open-secret',
        222,
        openPlatformNow,
        openPlatformNow,
        openPlatformUserId,
      ],
    );
    await pool.query(
      `
        INSERT INTO public.open_platform_docs (
          id,
          doc_key,
          title,
          category,
          http_method,
          route_path,
          status,
          scope_text,
          version_tag,
          description,
          sample_payload,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'published', $7, $8, $9, $10, $11, $11)
        ON CONFLICT (doc_key) DO UPDATE SET
          title = EXCLUDED.title,
          category = EXCLUDED.category,
          http_method = EXCLUDED.http_method,
          route_path = EXCLUDED.route_path,
          status = EXCLUDED.status,
          scope_text = EXCLUDED.scope_text,
          version_tag = EXCLUDED.version_tag,
          description = EXCLUDED.description,
          sample_payload = EXCLUDED.sample_payload,
          updated_at = EXCLUDED.updated_at
      `,
      [
        Number(openPlatformDocIdResult.rows[0]?.nextId ?? 1),
        'tenant-pg-open-doc',
        'Tenant PG Open Doc',
        '读取接口',
        'GET',
        '/api/public/open-platform/tenant-pg-smoke/orders/overview',
        'orders.read',
        'tenant-pg-v1',
        'Seeded for tenant PG open-platform smoke verification.',
        '{"marker":"tenant-pg-open-doc"}',
        openPlatformNow,
      ],
    );
    await pool.query(
      `
        INSERT INTO public.open_platform_whitelist_rules (
          id,
          rule_type,
          rule_value,
          description,
          enabled,
          hit_count,
          last_hit_at,
          created_at,
          updated_at,
          updated_by
        )
        VALUES ($1, 'ip', $2, $3, 1, $4, $5, $5, $5, $6)
      `,
      [
        Number(openPlatformRuleIdResult.rows[0]?.nextId ?? 1),
        '203.0.113.88/32',
        'Tenant PG open whitelist marker',
        7,
        openPlatformNow,
        openPlatformUserId,
      ],
    );
    await pool.query(
      `
        INSERT INTO public.open_platform_whitelist_rules (
          id,
          rule_type,
          rule_value,
          description,
          enabled,
          hit_count,
          last_hit_at,
          created_at,
          updated_at,
          updated_by
        )
        VALUES ($1, 'ip', $2, $3, 1, $4, $5, $5, $5, $6)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        Number(openPlatformRuleIdResult.rows[0]?.nextId ?? 1) + 1,
        '127.0.0.1',
        'Tenant PG local smoke allowlist',
        0,
        openPlatformNow,
        openPlatformUserId,
      ],
    );
    await pool.query(
      `
        INSERT INTO public.open_platform_call_logs (
          id,
          app_id,
          app_key,
          tenant_key,
          trace_id,
          http_method,
          route_path,
          request_ip,
          status_code,
          call_status,
          duration_ms,
          detail,
          created_at
        )
        VALUES ($1, (SELECT id FROM public.open_platform_apps WHERE app_key = $2 LIMIT 1), $2, $3, $4, 'GET', $5, $6, 403, 'blocked', 12, $7, $8)
      `,
      [
        Number(openPlatformCallLogIdResult.rows[0]?.nextId ?? 1),
        'tenant-pg-open-app',
        'tenant-pg-smoke',
        'tenant-pg-open-trace',
        '/api/public/open-platform/tenant-pg-smoke/orders/overview',
        '203.0.113.88',
        'Tenant PG blocked call marker',
        openPlatformNow,
      ],
    );

    const openAppsResponse = await fetchJson(`${baseUrl}/api/open-platform/apps`, {
      headers: tenantHeaders,
    });
    const openDocsResponse = await fetchJson(`${baseUrl}/api/open-platform/docs`, {
      headers: tenantHeaders,
    });
    const openSettingsResponse = await fetchJson(`${baseUrl}/api/open-platform/settings`, {
      headers: tenantHeaders,
    });
    const openWhitelistResponse = await fetchJson(`${baseUrl}/api/open-platform/whitelist`, {
      headers: tenantHeaders,
    });
    if (openAppsResponse.status !== 200) {
      throw new Error(`Tenant open-platform apps failed: ${openAppsResponse.text}`);
    }
    if (openDocsResponse.status !== 200) {
      throw new Error(`Tenant open-platform docs failed: ${openDocsResponse.text}`);
    }
    if (openSettingsResponse.status !== 200) {
      throw new Error(`Tenant open-platform settings failed: ${openSettingsResponse.text}`);
    }
    if (openWhitelistResponse.status !== 200) {
      throw new Error(`Tenant open-platform whitelist failed: ${openWhitelistResponse.text}`);
    }

    const tenantOpenPlatformAppsVerified = Boolean(
      openAppsResponse.json?.apps?.some?.(
        (item) =>
          String(item?.appKey ?? '') === 'tenant-pg-open-app' &&
          String(item?.secretMasked ?? '') === 'pg-only-mask',
      ),
    );
    const tenantOpenPlatformDocsVerified = Boolean(
      openDocsResponse.json?.docs?.some?.(
        (item) =>
          String(item?.docKey ?? '') === 'tenant-pg-open-doc' &&
          String(item?.samplePayload ?? '').includes('tenant-pg-open-doc'),
      ),
    );
    const tenantOpenPlatformSettingsVerified =
      String(openSettingsResponse.json?.settings?.webhookBaseUrl ?? '') ===
      'https://tenant-pg-open.example.com';
    const tenantOpenPlatformWhitelistVerified = Boolean(
      openWhitelistResponse.json?.rules?.some?.(
        (item) =>
          String(item?.ruleValue ?? '') === '203.0.113.88/32' &&
          Boolean(item?.enabled) === true,
      ),
    );
    if (!tenantOpenPlatformAppsVerified) {
      throw new Error('Tenant open-platform apps did not expose PostgreSQL-only marker data.');
    }
    if (!tenantOpenPlatformDocsVerified) {
      throw new Error('Tenant open-platform docs did not expose PostgreSQL-only marker data.');
    }
    if (!tenantOpenPlatformSettingsVerified) {
      throw new Error('Tenant open-platform settings did not expose PostgreSQL-only marker data.');
    }
    if (!tenantOpenPlatformWhitelistVerified) {
      throw new Error('Tenant open-platform whitelist did not expose PostgreSQL-only marker data.');
    }

    const publicDashboardPath = '/api/public/open-platform/tenant-pg-smoke/dashboard/summary';
    const publicOrdersOverviewPath = '/api/public/open-platform/tenant-pg-smoke/orders/overview';
    const publicDashboardCallLogCountBefore = await pool.query(
      `
        SELECT COUNT(*)::int AS "count"
        FROM public.open_platform_call_logs
        WHERE route_path = $1 AND call_status = 'success'
      `,
      [publicDashboardPath],
    );
    const publicOrdersCallLogCountBefore = await pool.query(
      `
        SELECT COUNT(*)::int AS "count"
        FROM public.open_platform_call_logs
        WHERE route_path = $1 AND call_status = 'success'
      `,
      [publicOrdersOverviewPath],
    );

    const publicDashboardResponse = await fetchJson(`${baseUrl}${publicDashboardPath}`, {
      headers: buildSignedOpenPlatformHeaders({
        appKey: 'tenant-pg-open-app',
        secret: openPlatformAppSecret,
        method: 'GET',
        routePath: publicDashboardPath,
      }),
    });
    const publicOrdersOverviewResponse = await fetchJson(`${baseUrl}${publicOrdersOverviewPath}`, {
      headers: buildSignedOpenPlatformHeaders({
        appKey: 'tenant-pg-open-app',
        secret: openPlatformAppSecret,
        method: 'GET',
        routePath: publicOrdersOverviewPath,
      }),
    });

    const publicDashboardCallLogCountAfter = await pool.query(
      `
        SELECT COUNT(*)::int AS "count"
        FROM public.open_platform_call_logs
        WHERE route_path = $1 AND call_status = 'success'
      `,
      [publicDashboardPath],
    );
    const publicOrdersCallLogCountAfter = await pool.query(
      `
        SELECT COUNT(*)::int AS "count"
        FROM public.open_platform_call_logs
        WHERE route_path = $1 AND call_status = 'success'
      `,
      [publicOrdersOverviewPath],
    );

    const tenantOpenPlatformPublicDashboardVerified =
      publicDashboardResponse.status === 200 &&
      Array.isArray(publicDashboardResponse.json?.summary) &&
      publicDashboardResponse.json.summary.length > 0;
    const tenantOpenPlatformPublicOrdersOverviewVerified =
      publicOrdersOverviewResponse.status === 200 &&
      typeof publicOrdersOverviewResponse.json?.totalOrders === 'number';
    const tenantOpenPlatformPublicDashboardCallLogVerified =
      Number(publicDashboardCallLogCountAfter.rows[0]?.count ?? 0) >
      Number(publicDashboardCallLogCountBefore.rows[0]?.count ?? 0);
    const tenantOpenPlatformPublicOrdersOverviewCallLogVerified =
      Number(publicOrdersCallLogCountAfter.rows[0]?.count ?? 0) >
      Number(publicOrdersCallLogCountBefore.rows[0]?.count ?? 0);
    if (!tenantOpenPlatformPublicDashboardVerified) {
      throw new Error(`Tenant open-platform public dashboard failed: ${publicDashboardResponse.text}`);
    }
    if (!tenantOpenPlatformPublicOrdersOverviewVerified) {
      throw new Error(`Tenant open-platform public orders overview failed: ${publicOrdersOverviewResponse.text}`);
    }
    if (!tenantOpenPlatformPublicDashboardCallLogVerified) {
      throw new Error('Tenant open-platform public dashboard did not record a PostgreSQL call log.');
    }
    if (!tenantOpenPlatformPublicOrdersOverviewCallLogVerified) {
      throw new Error('Tenant open-platform public orders overview did not record a PostgreSQL call log.');
    }

    const createdOpenPlatformAppResponse = await fetchJson(`${baseUrl}/api/open-platform/apps`, {
      method: 'POST',
      headers: tenantJsonHeaders,
      body: JSON.stringify({
        appName: 'Tenant PG Created App',
        ownerName: 'Tenant PG Created Owner',
        contactName: 'tenant-pg-created@example.com',
        callbackUrl: 'https://tenant-pg-created.example.com/callback',
        scopes: ['dashboard.read'],
        rateLimitPerMinute: 345,
      }),
    });
    if (createdOpenPlatformAppResponse.status !== 200 || !createdOpenPlatformAppResponse.json?.appKey) {
      throw new Error(`Tenant open-platform app create failed: ${createdOpenPlatformAppResponse.text}`);
    }
    const createdOpenPlatformApp = createdOpenPlatformAppResponse.json;
    const createdOpenPlatformAppPersisted = await pool.query(
      `
        SELECT
          id,
          app_key AS "appKey",
          status,
          rate_limit_per_minute AS "rateLimitPerMinute",
          secret_setting_key AS "secretSettingKey"
        FROM public.open_platform_apps
        WHERE app_key = $1
      `,
      [createdOpenPlatformApp.appKey],
    );
    if (createdOpenPlatformAppPersisted.rowCount !== 1) {
      throw new Error('Tenant open-platform created app was not persisted in PostgreSQL.');
    }
    const createdOpenPlatformAppId = Number(createdOpenPlatformAppPersisted.rows[0]?.id ?? 0);
    const tenantOpenPlatformAppCreateWriteVerified = createdOpenPlatformAppId > 0;

    const rotatedOpenPlatformSecretResponse = await fetchJson(
      `${baseUrl}/api/open-platform/apps/${createdOpenPlatformAppId}/secret/rotate`,
      {
        method: 'POST',
        headers: tenantHeaders,
      },
    );
    if (
      rotatedOpenPlatformSecretResponse.status !== 200 ||
      typeof rotatedOpenPlatformSecretResponse.json?.secretMasked !== 'string'
    ) {
      throw new Error(
        `Tenant open-platform app secret rotate failed: ${rotatedOpenPlatformSecretResponse.text}`,
      );
    }
    const rotatedOpenPlatformSecretPersisted = await pool.query(
      `
        SELECT value_masked AS "maskedValue"
        FROM public.secure_settings
        WHERE key = $1
      `,
      [createdOpenPlatformAppPersisted.rows[0]?.secretSettingKey ?? null],
    );
    const tenantOpenPlatformAppSecretRotateVerified =
      rotatedOpenPlatformSecretPersisted.rowCount === 1 &&
      String(rotatedOpenPlatformSecretPersisted.rows[0]?.maskedValue ?? '') ===
        String(rotatedOpenPlatformSecretResponse.json?.secretMasked ?? '');

    const appStatusWriteResponse = await fetchJson(
      `${baseUrl}/api/open-platform/apps/${createdOpenPlatformAppId}/status`,
      {
        method: 'POST',
        headers: tenantJsonHeaders,
        body: JSON.stringify({ status: 'suspended' }),
      },
    );
    if (appStatusWriteResponse.status !== 200) {
      throw new Error(`Tenant open-platform app status write failed: ${appStatusWriteResponse.text}`);
    }
    const appStatusPersisted = await pool.query(
      `
        SELECT status
        FROM public.open_platform_apps
        WHERE id = $1
      `,
      [createdOpenPlatformAppId],
    );
    const tenantOpenPlatformAppStatusWriteVerified =
      appStatusPersisted.rowCount === 1 &&
      String(appStatusPersisted.rows[0]?.status ?? '') === 'suspended';

    const settingsWriteResponse = await fetchJson(`${baseUrl}/api/open-platform/settings`, {
      method: 'POST',
      headers: tenantJsonHeaders,
      body: JSON.stringify({
        webhookBaseUrl: 'https://tenant-pg-settings-write.example.com',
        notifyEmail: 'tenant-pg-settings@example.com',
        publishedVersion: 'tenant-pg-v2',
        defaultRateLimitPerMinute: 333,
        signatureTtlSeconds: 444,
        whitelistEnforced: false,
      }),
    });
    if (settingsWriteResponse.status !== 200) {
      throw new Error(`Tenant open-platform settings write failed: ${settingsWriteResponse.text}`);
    }
    const settingsWritePersisted = await pool.query(
      `
        SELECT
          webhook_base_url AS "webhookBaseUrl",
          notify_email AS "notifyEmail",
          published_version AS "publishedVersion",
          default_rate_limit_per_minute AS "defaultRateLimitPerMinute",
          signature_ttl_seconds AS "signatureTtlSeconds",
          whitelist_enforced AS "whitelistEnforced"
        FROM public.open_platform_settings
        WHERE id = 1
      `,
    );
    const tenantOpenPlatformSettingsWriteVerified =
      settingsWritePersisted.rowCount === 1 &&
      String(settingsWritePersisted.rows[0]?.webhookBaseUrl ?? '') ===
        'https://tenant-pg-settings-write.example.com' &&
      String(settingsWritePersisted.rows[0]?.notifyEmail ?? '') ===
        'tenant-pg-settings@example.com' &&
      String(settingsWritePersisted.rows[0]?.publishedVersion ?? '') === 'tenant-pg-v2' &&
      Number(settingsWritePersisted.rows[0]?.defaultRateLimitPerMinute ?? 0) === 333 &&
      Number(settingsWritePersisted.rows[0]?.signatureTtlSeconds ?? 0) === 444 &&
      Number(settingsWritePersisted.rows[0]?.whitelistEnforced ?? 1) === 0;

    const whitelistCreateResponse = await fetchJson(`${baseUrl}/api/open-platform/whitelist`, {
      method: 'POST',
      headers: tenantJsonHeaders,
      body: JSON.stringify({
        ruleType: 'ip',
        ruleValue: '198.51.100.10/32',
        description: 'Tenant PG created whitelist rule',
        enabled: true,
      }),
    });
    if (whitelistCreateResponse.status !== 200 || !whitelistCreateResponse.json?.rule?.id) {
      throw new Error(`Tenant open-platform whitelist create failed: ${whitelistCreateResponse.text}`);
    }
    const createdWhitelistRuleId = Number(whitelistCreateResponse.json.rule.id);
    const whitelistToggleResponse = await fetchJson(
      `${baseUrl}/api/open-platform/whitelist/${createdWhitelistRuleId}/enabled`,
      {
        method: 'POST',
        headers: tenantJsonHeaders,
        body: JSON.stringify({ enabled: false }),
      },
    );
    if (whitelistToggleResponse.status !== 200) {
      throw new Error(`Tenant open-platform whitelist toggle failed: ${whitelistToggleResponse.text}`);
    }
    const whitelistPersisted = await pool.query(
      `
        SELECT
          rule_value AS "ruleValue",
          enabled
        FROM public.open_platform_whitelist_rules
        WHERE id = $1
      `,
      [createdWhitelistRuleId],
    );
    const tenantOpenPlatformWhitelistWriteVerified =
      whitelistPersisted.rowCount === 1 &&
      String(whitelistPersisted.rows[0]?.ruleValue ?? '') === '198.51.100.10/32' &&
      Number(whitelistPersisted.rows[0]?.enabled ?? 1) === 0;

    console.log(
      JSON.stringify(
        {
          ok: true,
          checkedAt: new Date().toISOString(),
          backend: target.backend,
          connectionString: target.connectionString,
          tenantId,
          tenantDashboardVerified: true,
          tenantOrdersOverviewVerified: true,
          tenantReportsCapabilityMissing: reportsCapabilityMissing,
          tenantReportsExportCapabilityMissing: reportsExportCapabilityMissing,
          tenantProductsCapabilityMissing: productsCapabilityMissing,
          tenantCustomersCapabilityMissing: customersCapabilityMissing,
          tenantOrdersListCapabilityMissing: ordersListCapabilityMissing,
          tenantOrderDetailCapabilityMissing: orderDetailCapabilityMissing,
          tenantOrdersExportCapabilityMissing: ordersExportCapabilityMissing,
          tenantFulfillmentWorkbenchCapabilityMissing: fulfillmentWorkbenchCapabilityMissing,
          tenantAfterSaleWorkbenchCapabilityMissing: afterSaleWorkbenchCapabilityMissing,
          tenantAfterSalesListCapabilityMissing: afterSalesListCapabilityMissing,
          tenantAfterSaleDetailCapabilityMissing: afterSaleDetailCapabilityMissing,
          tenantReportsContainsPgMarker: reportsContainsPgMarker,
          tenantReportsExportContainsPgMarker: reportsExportContainsPgMarker,
          tenantProductsContainsPgMarker: productsContainsPgMarker,
          tenantCustomersContainsPgMarker: customersContainsPgMarker,
          tenantOrdersListContainsPgMarker: ordersListContainsPgMarker,
          tenantOrderDetailContainsPgMarker: orderDetailContainsPgMarker,
          tenantOrdersExportContainsPgMarker: ordersExportContainsPgMarker,
          tenantFulfillmentWorkbenchContainsPgMarker: fulfillmentWorkbenchContainsPgMarker,
          tenantAfterSaleWorkbenchContainsPgMarker: afterSaleWorkbenchContainsPgMarker,
          tenantAfterSalesListContainsPgMarker: afterSalesListContainsPgMarker,
          tenantAfterSaleDetailContainsPgMarker: afterSaleDetailContainsPgMarker,
          tenantWorkspaceWriteVerified: true,
          tenantSystemAlertWriteVerified: true,
          tenantSystemAlertShadowDetailVerified,
          tenantSystemBackupWriteVerified: true,
          tenantSystemLogArchiveWriteVerified: true,
          tenantSystemRecoveryDrillWriteVerified: true,
          tenantMetricsVerified,
          tenantStoreAuthSessionCreateWriteVerified,
          tenantStoreAuthSessionDetailVerified,
          tenantStoreAuthSessionCompleteWriteVerified,
          tenantStoreAuthWebSessionSyncWriteVerified,
          tenantStoreAuthSessionEventsVerified,
          tenantStoreCredentialEventsVerified,
          tenantStoreCredentialEventSessionCapabilityMissing,
          tenantStoreCredentialEventStoreCapabilityMissing,
          tenantSourceSystemToggleWriteVerified,
          tenantSourceSystemTokenRotateWriteVerified,
          tenantSupplySourceSyncWriteVerified,
          tenantSupplySourceOrderDispatchWriteVerified,
          tenantDirectChargeQueueWriteVerified,
          tenantDirectChargeManualReviewQueueWriteVerified,
          tenantCardFulfillmentQueueWriteVerified,
          tenantCardOutboundResendQueueWriteVerified,
          tenantAiServiceSettingsWriteVerified,
          tenantAiServiceKnowledgeToggleWriteVerified,
          tenantAiServiceReplyTemplateToggleWriteVerified,
          tenantAiServiceDetailVerified,
          tenantAiServiceTakeoverWriteVerified,
          tenantFundWithdrawalWriteVerified,
          tenantFundWithdrawalStatusWriteVerified,
          tenantFundReconciliationWriteVerified,
          tenantOpenPlatformAppsVerified,
          tenantOpenPlatformDocsVerified,
          tenantOpenPlatformSettingsVerified,
          tenantOpenPlatformWhitelistVerified,
          tenantOpenPlatformAppCreateWriteVerified,
          tenantOpenPlatformAppSecretRotateVerified,
          tenantOpenPlatformPublicDashboardVerified,
          tenantOpenPlatformPublicOrdersOverviewVerified,
          tenantOpenPlatformPublicDashboardCallLogVerified,
          tenantOpenPlatformPublicOrdersOverviewCallLogVerified,
          tenantOpenPlatformAppStatusWriteVerified,
          tenantOpenPlatformWhitelistWriteVerified,
          tenantOpenPlatformSettingsWriteVerified,
          workspaceFeatureKey,
          systemAlertId: Number(systemAlertRow.id),
          systemAlertStatus,
          shadowDetailStatus,
          metricsActiveAlerts,
          metricsCriticalAlerts,
          metricsSuccessBackups,
          metricsDatabaseSize,
          usersCount: usersCount.rows[0]?.count ?? 0,
          productsCount: productsCount.rows[0]?.count ?? 0,
          workspaceActionRunCount: actionRunCount,
          workspaceLogCount: logsAfter,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        message:
          error instanceof Error
            ? error.message
            : 'SaaS tenant PostgreSQL business database smoke test failed.',
        logs: serverLogs.join('').trim(),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await shutdown(childProcess);
  await target.cleanup();
  fs.rmSync(smokeRoot, { recursive: true, force: true });
}
