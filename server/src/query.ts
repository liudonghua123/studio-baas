/**
 * Appwrite 风格的查询语法：
 *   equal("status", "active")        notEqual / greaterThan / greaterThanEqual
 *   lessThan / lessThanEqual         between("price", 10, 50)
 *   contains / startsWith / endsWith isNull("deletedAt")
 *   orderAsc("createdAt")            orderDesc("price")
 *   limit(20) / offset(40)           select("title", "price")
 *
 * 前端以 `?queries[]=equal("status","active")` 或 POST body 的 queries 数组传入。
 * 这里只做「解析 + 生成参数化 SQL」，不做字符串拼接，避免注入。
 */
export interface ParsedQueries {
  where: string[];
  params: any[];
  order: string | null;
  limit: number | null;
  offset: number | null;
  select: string[] | null;
}

const META: Record<string, string> = {
  $id: 'id',
  $createdAt: 'createdAt',
  $updatedAt: 'updatedAt',
};

const ident = (name: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Invalid attribute name "${name}" in query`);
  return `json_extract(data, '$.${name}')`;
};

/** 拆 `fn(a, b, "c")` 的参数，支持带转义的双引号字符串与数字 */
function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (ch === '\\' && i + 1 < raw.length) { buf += raw[++i]; continue; }
      if (ch === '"') { inStr = false; continue; }
      buf += ch;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === ',') {
      out.push(buf.trim()); buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim() || raw.trim() === '') out.push(buf.trim());
  return out;
}

const literal = (v: string): any => {
  const t = v.trim();
  if (t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
};

export function parseQueries(input: unknown): ParsedQueries {
  const list = Array.isArray(input) ? input.map(String) : input ? [String(input)] : [];
  const q: ParsedQueries = { where: [], params: [], order: null, limit: null, offset: null, select: null };

  for (const expr of list) {
    const m = /^\s*([a-zA-Z]+)\s*\((.*)\)\s*$/.exec(expr);
    if (!m) throw new Error(`Malformed query "${expr}"`);
    const [, fn, raw] = m;
    const args = splitArgs(raw);

    const column = (name: string) => META[name] ?? ident(name);

    switch (fn) {
      case 'equal': q.where.push(`${column(args[0])} = ?`); q.params.push(literal(args[1])); break;
      case 'notEqual': q.where.push(`${column(args[0])} IS NOT ?`); q.params.push(literal(args[1])); break;
      case 'greaterThan': q.where.push(`${column(args[0])} > ?`); q.params.push(literal(args[1])); break;
      case 'greaterThanEqual': q.where.push(`${column(args[0])} >= ?`); q.params.push(literal(args[1])); break;
      case 'lessThan': q.where.push(`${column(args[0])} < ?`); q.params.push(literal(args[1])); break;
      case 'lessThanEqual': q.where.push(`${column(args[0])} <= ?`); q.params.push(literal(args[1])); break;
      case 'between': q.where.push(`${column(args[0])} BETWEEN ? AND ?`); q.params.push(literal(args[1]), literal(args[2])); break;
      case 'contains': q.where.push(`${column(args[0])} LIKE ?`); q.params.push(`%${literal(args[1])}%`); break;
      case 'startsWith': q.where.push(`${column(args[0])} LIKE ?`); q.params.push(`${literal(args[1])}%`); break;
      case 'endsWith': q.where.push(`${column(args[0])} LIKE ?`); q.params.push(`%${literal(args[1])}`); break;
      case 'isNull': q.where.push(`${column(args[0])} IS NULL`); break;
      case 'isNotNull': q.where.push(`${column(args[0])} IS NOT NULL`); break;
      case 'orderAsc': q.order = `${column(args[0])} ASC`; break;
      case 'orderDesc': q.order = `${column(args[0])} DESC`; break;
      case 'limit': q.limit = Math.max(1, Number(literal(args[0])) || 25); break;
      case 'offset': q.offset = Math.max(0, Number(literal(args[0])) || 0); break;
      case 'select': q.select = args.filter(Boolean); break;
      default:
        throw new Error(`Unsupported query operator "${fn}"`);
    }
  }
  return q;
}
