import type { Dict } from '../i18n.types';

/** Storage page: buckets, files, upload zone and the bucket / file modals. */
export const zhStorage: Dict = {
  /* ----------------------------------------------------------- page head */
  'Buckets & files': '存储桶与文件',
  'Object storage with per-bucket limits, extensions and access policy. Encryption and compression are policy records only — files are stored as plaintext on the local disk.':
    '对象存储，支持按存储桶限制文件大小、扩展名与访问策略。加密/压缩仅作策略记录，文件实际以明文存放在本地磁盘。',
  'New bucket': '新建存储桶',
  'Upload file': '上传文件',
  'Uploading…': '上传中…',

  /* -------------------------------------------------------------- toasts */
  '{name} uploaded': '{name} 已上传',
  '{name}: {message}': '{name}：{message}',
  'Bucket created': '存储桶已创建',
  'Bucket deleted': '存储桶已删除',
  'File deleted': '文件已删除',

  /* --------------------------------------------------------------- stats */
  '{n} files · {size}': '{n} 个文件 · {size}',
  'Bucket size': '存储桶大小',
  'of {size} per-file limit': '单文件上限 {size}',
  Files: '文件',
  'any type': '任意类型',
  Encryption: '加密',
  'policy only · stored as plain files': '仅为策略 · 实际以明文文件存储',
  Compression: '压缩',
  'policy only · no server-side transform': '仅为策略 · 无服务端转换',
  'transforms disabled': '已关闭转换',
  encrypted: '已加密',

  /* --------------------------------------------------------------- files */
  'Select a bucket': '选择一个存储桶',
  'Drop files to upload': '拖拽文件到此处上传',
  'or click to browse · max {size}': '或点击选择文件 · 上限 {size}',
  'Add file': '添加文件',
  Preview: '预览',
  'Preview unavailable': '无法预览',
  'Download the file to inspect it.': '下载文件后查看内容。',
  'File ID': '文件 ID',
  Uploaded: '上传时间',

  /* ------------------------------------------------------------- buckets */
  'Delete bucket': '删除存储桶',
  'Delete bucket “{name}” and all its files?': '删除存储桶「{name}」及其全部文件？',
  'Create bucket': '创建存储桶',
  'Buckets isolate files and define their own permissions.': '存储桶隔离文件，并各自定义权限。',
  'e.g. avatars': '例如：头像',
  'Max file size (MB)': '单文件上限（MB）',
  'Allowed extensions': '允许的扩展名',
  'Encrypt files at rest (AES-256)': '静态加密文件（AES-256）',
  'Enable image transformations': '启用图片转换',
};
