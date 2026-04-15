import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';

import App from './App.tsx';
import './index.css';
import './styles/shell.css';
import './styles/dashboard.css';
import './styles/login.css';
import './styles/pages.css';
import './styles/workspace.css';
import './styles/responsive.css';
import './styles/overrides.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#6366f1',
          colorInfo: '#6366f1',
          colorSuccess: '#22c55e',
          colorWarning: '#f59e0b',
          colorError: '#ef4444',
          colorBgLayout: '#0a0a0f',
          colorBgContainer: '#12121a',
          colorBgElevated: '#1a1a28',
          colorBorder: 'rgba(255, 255, 255, 0.06)',
          colorBorderSecondary: 'rgba(255, 255, 255, 0.04)',
          colorText: '#f0f0f5',
          colorTextSecondary: 'rgba(255, 255, 255, 0.45)',
          colorTextTertiary: 'rgba(255, 255, 255, 0.3)',
          borderRadius: 12,
          borderRadiusLG: 16,
          fontFamily:
            '"Inter", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Layout: {
            headerBg: 'transparent',
            siderBg: 'transparent',
            bodyBg: 'transparent',
          },
          Button: {
            controlHeightLG: 44,
            borderRadiusLG: 12,
            fontWeight: 600,
          },
          Card: {
            borderRadiusLG: 16,
          },
          Input: {
            controlHeightLG: 44,
          },
          Select: {
            controlHeightLG: 44,
          },
          Segmented: {
            trackBg: 'rgba(255,255,255,0.04)',
            itemSelectedBg: 'rgba(99, 102, 241, 0.15)',
            itemSelectedColor: '#a5b4fc',
          },
          Table: {
            headerBg: 'rgba(255, 255, 255, 0.02)',
            headerColor: 'rgba(255, 255, 255, 0.6)',
            borderColor: 'rgba(255, 255, 255, 0.04)',
            rowHoverBg: 'rgba(99, 102, 241, 0.04)',
          },
          Tag: {
            borderRadiusSM: 6,
          },
          Modal: {
            contentBg: '#1a1a28',
            headerBg: '#1a1a28',
          },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </StrictMode>,
);
