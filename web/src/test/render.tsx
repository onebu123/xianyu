import type { ReactElement } from 'react';

import { App as AntdApp } from 'antd';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

export function renderWithProviders(ui: ReactElement) {
  return render(
    <MemoryRouter>
      <AntdApp>{ui}</AntdApp>
    </MemoryRouter>,
  );
}
