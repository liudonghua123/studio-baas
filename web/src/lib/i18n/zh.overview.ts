import type { Dict } from '../i18n.types';

/** Overview dashboard: greeting, stat cards, traffic, health, recent activity, shortcuts. */
export const zhOverview: Dict = {
  /* ------------------------------------------------------------ page head */
  'Project healthy · {region}': '项目运行正常 · {region}',
  '{greeting}, Alex': '{greeting}，Alex',
  'Good morning': '早上好',
  'Good afternoon': '下午好',
  'Good evening': '晚上好',
  '{project} is running on the Studio BaaS edge.': '{project} 正运行在 Studio BaaS 边缘网络上。',
  '{requests} API requests in the last 24 hours, {failed} failed execution.':
    '过去 24 小时共 {requests} 次 API 请求，{failed} 次执行失败。',
  '{requests} API requests in the last 24 hours, {failed} failed executions.':
    '过去 24 小时共 {requests} 次 API 请求，{failed} 次执行失败。',

  /* ----------------------------------------------------------- stat cards */
  Documents: '文档',
  'Files stored': '已存文件',
  'Function runs · 24h': '函数运行 · 24 小时',
  'End users': '终端用户',
  '{n} collections': '{n} 个集合',
  '{n} functions deployed': '已部署 {n} 个函数',
  '{n} messages sent': '已发送 {n} 条消息',

  /* -------------------------------------------------------- API traffic */
  'API traffic': 'API 流量',
  'Requests and errors · last 14 days': '请求与错误 · 最近 14 天',
  Requests: '请求',
  Errors: '错误',
  'vs. previous week': '较上一周',

  /* ------------------------------------------------------ service health */
  'Service health': '服务健康',
  'All regions · realtime': '全部区域 · 实时',
  Operational: '运行正常',
  'Average uptime': '平均可用率',
  'Edge PoPs': '边缘节点',
  'Errors / 24h': '24 小时错误数',

  /* --------------------------------------------------- recent executions */
  'Recent executions': '最近执行',
  'Serverless invocations across all functions': '全部函数的无服务器调用',
  'View all': '查看全部',
  Function: '函数',
  Trigger: '触发器',
  Duration: '耗时',
  When: '时间',

  /* --------------------------------------------- documents by collection */
  'Documents by collection': '按集合统计的文档',
  'Distribution across your database': '文档在数据库中的分布',

  /* ------------------------------------------------------ quick actions */
  'Write a cloud function': '编写云函数',
  'Edit Node 22 code in the browser and execute it instantly.': '在浏览器中编辑 Node 22 代码并立即执行。',
  'Ship a site live': '上线一个站点',
  'Edit HTML/CSS/JS with a live iframe preview and deploy.': '在 iframe 实时预览中编辑 HTML/CSS/JS 并部署。',
  'Ask the AI operator': '向 AI 操作员提问',
  'DeepSeek can query, create and deploy across every service.': 'DeepSeek 可以跨服务查询、创建与部署。',
  'Send a message': '发送消息',
  'Email, SMS or push through the unified messaging API.': '通过统一的消息 API 发送邮件、短信或推送。',
};
