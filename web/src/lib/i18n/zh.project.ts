import type { Dict } from '../i18n.types';

/** Projects · Members · AI assistant. */
export const zhProject: Dict = {
  /* ------------------------------------------------------- projects */
  Workspace: '工作空间',
  'Each project has its own collections, buckets, functions, sites, members and API keys. Switching projects only changes the current context — data is never shared.':
    '每个项目拥有独立的集合、桶、函数、站点、成员与 API Key。切换项目只影响当前上下文，数据互不可见。',
  'No projects yet': '还没有项目',
  'Create a project to get started.': '创建一个项目开始使用',
  current: '当前',
  'No description yet.': '暂无描述',
  collections: '集合',
  functions: '函数',
  sites: '站点',
  members: '成员',
  'created {time}': '创建于 {time}',
  'Open console': '打开控制台',
  'Switch & open': '切换并打开',
  'Delete project': '删除项目',
  'Project name is required': '请填写项目名称',
  'Project {name} created': '项目 {name} 已创建',
  'Delete project {name}? Its collections, functions, sites and files go with it.':
    '删除项目 {name}？其集合、函数、站点与文件都会一起删除。',
  'Project deleted': '项目已删除',
  'Create project': '创建项目',
  'Resources are isolated per project, with members and permissions configured separately.':
    '资源按项目隔离，可分别配置成员与权限',
  'e.g. Acme Production': '例如 Acme Production',
  'What lives in this project?': '这个项目里放些什么？',
  'Frankfurt (fra)': '法兰克福 (fra)',
  'Amsterdam (ams)': '阿姆斯特丹 (ams)',
  'Washington (iad)': '华盛顿 (iad)',
  'Singapore (sgp)': '新加坡 (sgp)',
  Free: '免费',
  Pro: '专业版',
  Enterprise: '企业版',

  /* -------------------------------------------------------- members */
  'Access control': '访问控制',
  'Members & roles': '成员与角色',
  'Roles are scoped to a project: the same person can hold different permissions in different projects. API keys reuse the same permission points — humans and machines get equal rights.':
    '角色是项目级的：同一个人在不同项目可以拥有不同权限。API Key 复用同一套权限点，人机同权。',
  'Requires admin or above': '需要 admin 及以上角色',
  'Add member': '添加成员',
  'Project members': '项目成员',
  '{n} people have access to this project': '共 {n} 人可访问此项目',
  'No members yet': '还没有成员',
  'Create a user in Auth, then invite them here.': '先在 Auth 中创建用户，再回来邀请。',
  Member: '成员',
  Role: '角色',
  you: '你',
  'Your access': '你的权限',
  'Resolved from your role in this project': '由你在本项目中的角色推导得出',
  '{n} permissions': '{n} 个权限点',
  'Permission matrix': '权限矩阵',
  'Roles × permission points; API key scopes use the same permission points.':
    '角色 × 权限点；API Key 的 scope 使用同一组权限点',
  Permission: '权限点',
  'Remove {name} from the project?': '将 {name} 从项目中移除？',
  'Member removed': '成员已移除',
  'Email is required': '请填写邮箱',
  'Added to the project': '已加入项目',
  '{name} → {role}': '{name} → {role}',
  'Adding…': '添加中…',
  'Add to project': '加入项目',
  'The invitee must already be a user in this project’s Auth.':
    '被邀请人必须已经是该项目所在 Auth 中的用户',
  'Need a new user? Create one on the Auth page first, then come back to invite them.':
    '需要新用户？先到 Auth 页面创建，再回来邀请。',

  /* ------------------------------------------- permission point labels */
  'View project': '查看项目',
  'Update settings': '修改设置',
  'View members': '查看成员',
  'Invite / change roles': '邀请 / 调整角色',
  'Read collections & documents': '读取集合与文档',
  'Create / update / delete': '创建 / 更新 / 删除',
  'Read buckets & files': '读取桶与文件',
  'Upload / delete files': '上传 / 删除文件',
  'Read code & executions': '读取代码与执行记录',
  'Edit code & configuration': '编辑代码与配置',
  'Execute functions': '执行函数',
  'Read sites': '读取站点',
  'Edit files & settings': '编辑文件与设置',
  'Read end users': '读取终端用户',
  'Create / block users': '创建 / 禁用用户',
  'Read messages': '读取消息',
  'View keys': '查看密钥',
  'Create / revoke keys': '创建 / 撤销密钥',
  'Read request logs': '读取请求日志',

  /* ------------------------------------------------------------- ai */
  'DeepSeek Operator': 'DeepSeek 操作员',
  'Connecting…': '连接中…',
  '{n} tools available': '{n} 个工具可用',
  'Live model': '实时模型',
  Clear: '清空',
  'What should we build today?': '今天想构建点什么？',
  'I can operate every service in this project through tool calls.':
    '我可以通过工具调用操作这个项目里的每一项服务。',
  'is not set — running a local rule engine that still performs real tool calls. Add a key in':
    '未设置 —— 当前运行本地规则引擎，仍会发起真实的工具调用。可在',
  'Settings → AI': '设置 → AI',
  'for full autonomous multi-step planning.': '中填写密钥，以启用完整的多步自主规划。',
  'Try one of these': '试试这些',
  'Ask DeepSeek to query data, run functions, edit sites… (⌘↵ to send)':
    '让 DeepSeek 查询数据、运行函数、编辑站点…（⌘↵ 发送）',
  'tools: {n}': '工具：{n} 个',
  'deepseek tool-calling': 'deepseek 工具调用',
  'local rule engine': '本地规则引擎',
  'Request failed: {message}': '请求失败：{message}',
  'Connected tools': '已连接工具',
  'OpenAI-compatible tool calling, up to 6 planning steps per turn.':
    '兼容 OpenAI 的工具调用，每轮最多 6 步规划。',
  'Demo mode: deterministic intents mapped to real tools. Add a key in Settings.':
    '演示模式：确定性的意图映射到真实工具。可在设置中填写密钥。',
  'Your message goes to the harness with {n} tool schemas.':
    '你的消息会连同 {n} 个工具 schema 一起发送给执行框架。',
  'DeepSeek picks the tools; the server executes them against the live project.':
    'DeepSeek 负责挑选工具，服务端针对真实项目执行调用。',
  'Results feed back into the model for the final answer.': '结果回传给模型，用于生成最终回答。',
  'Every call is traced below the reply — audit exactly what changed.':
    '每次调用都会记录在回复下方 —— 可精确审计究竟改动了什么。',
  'With a key:': '配置密钥后：',
  '“Change the hero headline on aurora-storefront and redeploy” — the agent edits index.html and redeploys.':
    '「把 aurora-storefront 的 hero 标题改掉并部署」—— 智能体会修改 index.html 并重新部署。',
  '{n} tool call executed': '{n} 次工具调用已执行',
  '{n} tool calls executed': '{n} 次工具调用已执行',
  args: '参数',
  result: '结果',

  /* ------------------------------------------------ ai capability cards */
  Insights: '洞察',
  'Create collections, add fields, read and write documents': '建集合、加字段、增删改查文档',
  'Read and edit code, run it and inspect logs': '读改代码、执行并查看日志',
  'Edit HTML/CSS/JS and deploy live': '改 HTML/CSS/JS 并部署上线',
  'Create users, check status and labels': '创建用户、查看状态与标签',
  'Send email / SMS / push': '发送邮件 / SMS / Push',
  'Metrics, executions and request logs': '指标、执行记录与请求日志',

  /* --------------------------------------------------- ai prompt chips */
  'Give me a project overview — documents, users and functions':
    '给我一个项目概览，说明文档、用户和函数的情况',
  'List every collection with its document count': '列出所有集合以及每个集合的文档数量',
  'Run the Store analytics function and explain the result': '执行 Store analytics 函数并解释结果',
  'Show the latest error logs and suggest fixes': '显示最近的错误日志并给出修复建议',
  'List all collections': '列出所有集合',
  'Run the Order webhook': '执行 Order webhook',
  'Latest error logs': '最近的错误日志',
  'Project metrics overview': '项目指标概览',

  /* ------------------------------------------- ai sidebar tool tooltips */
  'List all database collections with document counts and attribute definitions.':
    '列出所有数据库集合，包含文档数量与属性定义。',
  'Create a new database collection (table) in the project.': '在项目中新建一个数据库集合（表）。',
  'Add an attribute/column to an existing collection.': '为现有集合添加属性（列）。',
  'List the indexes of a collection and whether each one is available.':
    '列出集合的索引，并标注每个索引是否可用。',
  'Create an index on a collection. Leftmost attributes are used first, so order matters.':
    '为集合创建索引。最左属性优先命中，因此顺序很重要。',
  'Run EXPLAIN QUERY PLAN for a list query and report whether an index is used.':
    '对列表查询执行 EXPLAIN QUERY PLAN，并报告是否命中索引。',
  'Drop an index from a collection.': '删除集合中的索引。',
  'List or search documents inside a collection.': '列出或搜索集合中的文档。',
  'Create a document (row) inside a collection. Data must satisfy the collection attributes.':
    '在集合中创建文档（行），数据必须符合集合的属性定义。',
  'Update an existing document by id.': '按 ID 更新已有文档。',
  'Delete a document by id.': '按 ID 删除文档。',
  'List storage buckets and the files inside them.': '列出存储桶及其中的文件。',
  'Delete a file from storage by file id.': '按文件 ID 从存储中删除文件。',
  'List serverless functions with runtime, trigger and last execution status.':
    '列出无服务器函数及其运行时、触发方式与最近一次执行状态。',
  'Get a function definition including its source code and environment variables.':
    '获取函数定义，包含源码与环境变量。',
  'Replace the source code of a function (online code editing).': '替换函数源码（在线编辑代码）。',
  'Create a new Node.js serverless function.': '新建一个 Node.js 无服务器函数。',
  'Execute a function synchronously and return its logs, response and duration.':
    '同步执行函数，返回日志、响应与耗时。',
  'List the immutable deploy history of a function (version, label, author, time).':
    '列出函数不可变的部署历史（版本、标签、作者、时间）。',
  'Roll a function back to an earlier version. The current code is kept as a new version.':
    '将函数回滚到较早版本，当前代码会保留为一个新版本。',
  'List recent function executions with status, duration and errors.':
    '列出近期函数执行的状态、耗时与错误。',
  'List hosted sites with framework, domain and status.': '列出托管的站点及其框架、域名与状态。',
  'Create or overwrite a file in a site (index.html, styles.css, app.js …).':
    '在站点中创建或覆盖文件（index.html、styles.css、app.js …）。',
  'Deploy the current site files to production preview.': '将当前站点文件部署到生产预览。',
  'List end users of the project with status and labels.': '列出项目的终端用户及其状态与标签。',
  'Create a new end user account.': '新建一个终端用户账号。',
  'Delete an end user by id.': '按 ID 删除终端用户。',
  'Send an email, SMS or push message through the messaging service.':
    '通过消息服务发送邮件、短信或推送。',
  'Get project-wide metrics: documents, files, storage, executions, users and request trend.':
    '获取项目整体指标：文档、文件、存储、执行、用户与请求趋势。',
  'Get recent API request logs for debugging.': '获取近期 API 请求日志，用于排查问题。',
  'List recently sent messages.': '列出最近发送的消息。',
  'Create a new API key with scopes.': '创建带 scope 的新 API 密钥。',
  'List cron schedules of the project with timezone, next run and last status.':
    '列出项目的 cron 定时任务及其时区、下次运行时间与最近状态。',
  'Schedule a function on a cron expression in a given IANA timezone.':
    '按 cron 表达式在指定 IANA 时区调度函数。',
  'Bind a function to a GitHub repository branch so that pushes deploy it.':
    '把函数绑定到 GitHub 仓库分支，push 即部署。',
  'Pull the bound repository file into the function (deploy) and report the commit.':
    '把绑定的仓库文件拉取进函数（部署），并报告对应的提交。',
  'List projects and the current role of the caller in each of them.':
    '列出项目，以及调用者在每个项目中的当前角色。',
};
