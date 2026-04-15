import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Result } from 'antd';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * 全局错误边界：捕获渲染异常，防止白屏
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 页面渲染异常:', error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  handleBack = () => {
    this.setState({ hasError: false, error: null });
    window.location.hash = '';
    window.location.pathname = '/';
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--color-bg-layout, #0a0a0f)',
        }}>
          <Result
            status="error"
            title="页面发生异常"
            subTitle={this.state.error?.message || '未知错误，请刷新页面重试。'}
            extra={[
              <Button key="reload" type="primary" onClick={this.handleReload}>
                刷新页面
              </Button>,
              <Button key="home" onClick={this.handleBack}>
                返回首页
              </Button>,
            ]}
          />
        </div>
      );
    }

    return this.props.children;
  }
}
