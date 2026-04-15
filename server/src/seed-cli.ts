import { appConfig } from './config.js';
import { StatisticsDatabase } from './database.js';

if (appConfig.runtimeMode !== 'demo') {
  throw new Error('seed-cli 仅允许在 demo 模式下执行，避免误写生产库。');
}

const db = new StatisticsDatabase(appConfig.dbPath);
db.initialize({
  forceReseed: true,
  runtimeMode: 'demo',
  seedDemoData: true,
  bootstrapAdmin: appConfig.bootstrapAdmin,
});
db.close();

console.log(`演示数据已重建: ${appConfig.dbPath}`);
