# 开源依赖与许可证说明

## 采用方案

### 1. Ant Design Pro

- 来源：[ant-design/ant-design-pro](https://github.com/ant-design/ant-design-pro)
- 许可证：MIT
- 用途：后台布局、企业级页面结构参考
- 选择原因：适合快速构建统计后台，页面组织与组件风格成熟

### 2. Ant Design / Ant Design Pro Components

- 来源：[Ant Design](https://ant.design/) / [Pro Components](https://procomponents.ant.design/)
- 许可证：MIT
- 用途：表单、布局、卡片、页面容器、统计组件
- 选择原因：适合中后台业务场景，适配销售统计页面

### 3. Apache ECharts

- 来源：[Apache ECharts](https://echarts.apache.org/)
- 许可证：Apache-2.0
- 用途：销售趋势、来源分布、订单状态、地区分布图表
- 选择原因：图表类型完整，适合统计分析后台

### 4. Fastify

- 来源：[fastify/fastify](https://github.com/fastify/fastify)
- 许可证：MIT
- 用途：后端接口、认证、静态资源服务
- 选择原因：启动快、结构清晰、适合轻量级可交付项目

## 评估过但未采用

### NocoBase

- 来源：[nocobase/nocobase](https://github.com/nocobase/nocobase)
- 许可证：AGPL-3.0
- 未采用原因：许可证传播要求更严格，不适合作为当前可商用交付的默认底座

## 许可证风险说明

- 当前项目自身采用 MIT 许可证
- Apache-2.0 组件需要保留版权与许可证声明
- 若未来接入更多图标、字体或第三方数据源，需要补充对应许可证检查

## 交付边界说明

- 当前演示数据由本项目本地脚本生成，不来源于目标站抓取数据
- 当前实现复用了开源中后台与图表组件，没有复制目标站源码
- 若未来接入第三方业务系统、真实订单数据或品牌素材，需要再次补充合规与许可证检查