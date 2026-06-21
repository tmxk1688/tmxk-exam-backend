const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/exam_db';
const DB_NAME = process.env.MONGODB_DB || 'exam_db';

let client = null;
let db = null;

async function connect() {
  if (!client) {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
  }
  return db;
}

function getDB() {
  if (!db) {
    throw new Error('Database not connected. Call connect() first.');
  }
  return db;
}

function collection(name) {
  return getDB().collection(name);
}

// SQLite-compatible API (sync style, backed by async MongoDB)
class PreparedStatement {
  constructor(sql) {
    this.sql = sql.trim();
    this._isSelect = /^SELECT/i.test(this.sql);
    this._isInsert = /^INSERT/i.test(this.sql);
    this._isUpdate = /^UPDATE/i.test(this.sql);
    this._isDelete = /^DELETE/i.test(this.sql);
  }

  _parseSQL() {
    const sql = this.sql;
    const trimmed = sql.trim();

    let tableName = null;
    let whereClause = null;
    let setClause = null;

    const fromMatch = trimmed.match(/FROM\s+(\w+)/i);
    const intoMatch = trimmed.match(/INTO\s+(\w+)/i);
    const updateMatch = trimmed.match(/UPDATE\s+(\w+)/i);
    const deleteMatch = trimmed.match(/DELETE FROM\s+(\w+)/i);

    if (fromMatch) tableName = fromMatch[1];
    else if (intoMatch) tableName = intoMatch[1];
    else if (updateMatch) tableName = updateMatch[1];
    else if (deleteMatch) tableName = deleteMatch[1];

    // Extract WHERE clause
    const whereMatch = trimmed.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
    if (whereMatch) whereClause = whereMatch[1].trim();

    // Extract SET clause
    const setMatch = trimmed.match(/SET\s+(.+?)(?:\s+WHERE|$)/i);
    if (setMatch) setClause = setMatch[1].trim();

    // Extract ORDER BY
    const orderMatch = trimmed.match(/ORDER BY\s+(.+?)(?:\s+LIMIT|$)/i);
    let orderBy = null;
    if (orderMatch) {
      const orderStr = orderMatch[1].trim();
      const parts = orderStr.split(/\s+/);
      const field = parts[0];
      const dir = parts[1]?.toLowerCase() === 'desc' ? -1 : 1;
      orderBy = { field, dir };
    }

    // Extract LIMIT
    const limitMatch = trimmed.match(/LIMIT\s+(\d+)/i);
    const limit = limitMatch ? parseInt(limitMatch[1], 10) : null;

    // Extract specific columns for SELECT
    let selectFields = null;
    if (/^SELECT/.test(trimmed) && !/SELECT\s+\*/i.test(trimmed)) {
      const selectMatch = trimmed.match(/SELECT\s+(.+?)\s+FROM/i);
      if (selectMatch) {
        selectFields = selectMatch[1].split(',').map(s => s.trim());
      }
    }

    // Extract INSERT field names
    let insertFields = null;
    const insertMatch = trimmed.match(/INSERT\s+INTO\s+\w+\s*\(([^)]+)\)/i);
    if (insertMatch) {
      insertFields = insertMatch[1].split(',').map(s => s.trim());
    }

    return { tableName, whereClause, setClause, orderBy, limit, selectFields, insertFields };
  }

  _buildWhereQuery(whereClause, params) {
    if (!whereClause) return {};

    let paramIndex = 0;
    let query = whereClause.replace(/\?/g, () => {
      const val = params[paramIndex++];
      if (val === undefined) return 'undefined';
      if (val === null) return 'null';
      if (typeof val === 'number') return val;
      return JSON.stringify(String(val));
    });

    // Convert SQL operators to MongoDB
    query = query.replace(/(\w+)\s*=\s*'(\w+)'/g, '"$1": "$2"');
    query = query.replace(/(\w+)\s*=\s*"([^"]+)"/g, '"$1": "$2"');
    query = query.replace(/(\w+)\s*=\s*(\d+)/g, '"$1": $2');
    query = query.replace(/(\w+)\s*=\s*(null)/gi, '"$1": null');
    query = query.replace(/(\w+)\s*<>\s*(\d+)/g, '"$1": { "$ne": $2 }');
    query = query.replace(/(\w+)\s*LIKE\s*'([^']+)'/gi, (m, field, pattern) => {
      const regexPattern = pattern.replace(/%/g, '.*');
      return `"${field}": { "$regex": "${regexPattern}", "$options": "i" }`;
    });
    query = query.replace(/(\w+)\s*IN\s*\(([^)]+)\)/gi, (m, field, values) => {
      const valArray = values.split(',').map(v => {
        const t = v.trim().replace(/'/g, '');
        return isNaN(t) ? `"${t}"` : t;
      });
      return `"${field}": { "$in": [${valArray}] }`;
    });
    query = query.replace(/(\w+)\s*IS\s+NULL/gi, '"$1": null');
    query = query.replace(/(\w+)\s*IS\s+NOT\s+NULL/gi, '"$1": { "$ne": null }');
    query = query.replace(/\s+AND\s+/gi, ', ');
    query = query.replace(/\s+OR\s+/gi, ', ');

    try {
      return JSON.parse(`{${query}}`);
    } catch {
      return {};
    }
  }

  _buildSetDoc(setClause, params) {
    if (!setClause) return {};

    const doc = {};
    const assignments = setClause.split(',').map(s => s.trim());

    let paramIndex = 0;
    for (const assignment of assignments) {
      const match = assignment.match(/^(\w+)\s*=\s*\?$/);
      if (match) {
        doc[match[1]] = params[paramIndex++];
      }
    }

    return doc;
  }

  _buildInsertDoc(trimmed, params) {
    const { insertFields } = this._parseSQL();
    if (!insertFields) return {};

    const doc = {};
    let paramIndex = 0;

    // Count ? placeholders in VALUES
    const valuesMatch = trimmed.match(/VALUES\s*\(([^)]+)\)/i);
    if (valuesMatch) {
      const valueParts = valuesMatch[1].split(',').map(v => v.trim());
      let startIndex = params.length - valueParts.filter(v => v === '?').length;

      for (let i = 0; i < valueParts.length; i++) {
        const part = valueParts[i].trim();
        if (part === '?') {
          if (insertFields[i]) {
            doc[insertFields[i]] = params[startIndex++];
          }
        } else if (part.startsWith("'") && part.endsWith("'")) {
          if (insertFields[i]) {
            doc[insertFields[i]] = part.slice(1, -1);
          }
        } else if (part.match(/^datetime\(/i)) {
          if (insertFields[i]) {
            doc[insertFields[i]] = new Date().toLocaleString('zh-CN', { hour12: false });
          }
        } else if (part.match(/^\d+$/)) {
          if (insertFields[i]) {
            doc[insertFields[i]] = parseInt(part, 10);
          }
        } else if (part.match(/^\d+\.\d+$/)) {
          if (insertFields[i]) {
            doc[insertFields[i]] = parseFloat(part);
          }
        }
      }
    }

    return doc;
  }

  async get(...params) {
    const { tableName, whereClause, orderBy, limit, selectFields } = this._parseSQL();
    if (!tableName) return null;

    const col = collection(tableName);
    const query = this._buildWhereQuery(whereClause, params);

    let cursor = col.find(query, { projection: selectFields ? { _id: 0, ...Object.fromEntries(selectFields.map(f => [f, 1])) } : {} });
    if (orderBy) {
      cursor = cursor.sort({ [orderBy.field]: orderBy.dir });
    }
    if (limit !== null) {
      cursor = cursor.limit(limit);
    } else {
      cursor = cursor.limit(1);
    }

    const rows = await cursor.toArray();
    return rows[0] || null;
  }

  async all(...params) {
    const { tableName, whereClause, orderBy, limit, selectFields } = this._parseSQL();
    if (!tableName) return [];

    const col = collection(tableName);
    const query = this._buildWhereQuery(whereClause, params);

    let cursor = col.find(query, { projection: selectFields ? { _id: 0, ...Object.fromEntries(selectFields.map(f => [f, 1])) } : {} });
    if (orderBy) {
      cursor = cursor.sort({ [orderBy.field]: orderBy.dir });
    }
    if (limit !== null) {
      cursor = cursor.limit(limit);
    }

    return cursor.toArray();
  }

  async run(...params) {
    const trimmed = this.sql;
    const { tableName, whereClause, setClause } = this._parseSQL();

    if (!tableName) {
      return { changes: 0, lastInsertRowid: null };
    }

    const col = collection(tableName);

    if (this._isInsert) {
      const doc = this._buildInsertDoc(trimmed, params);
      const result = await col.insertOne(doc);
      return { changes: 1, lastInsertRowid: result.insertedId.toString() };
    }

    if (this._isUpdate) {
      const query = this._buildWhereQuery(whereClause, params);
      const updateDoc = this._buildSetDoc(setClause, params);
      const result = await col.updateOne(query, { $set: updateDoc });
      return { changes: result.modifiedCount, lastInsertRowid: null };
    }

    if (this._isDelete) {
      const query = this._buildWhereQuery(whereClause, params);
      const result = await col.deleteOne(query);
      return { changes: result.deletedCount, lastInsertRowid: null };
    }

    return { changes: 0, lastInsertRowid: null };
  }
}

function prepare(sql) {
  return new PreparedStatement(sql);
}

async function exec(sql) {
  if (!sql || !sql.trim()) return;

  const trimmed = sql.trim();
  const statements = trimmed.split(';').filter(s => s.trim());

  for (const stmt of statements) {
    const s = stmt.trim();
    if (!s) continue;

    // CREATE TABLE
    const createMatch = s.match(/CREATE TABLE IF NOT EXISTS (\w+)\s*\((.+)\)/is);
    if (createMatch) {
      const tableName = createMatch[1];
      try {
        await getDB().createCollection(tableName);
      } catch (e) { }
      continue;
    }

    // ALTER TABLE ADD COLUMN
    if (/^ALTER TABLE/i.test(s)) {
      // MongoDB schema-less, no need to alter
      continue;
    }

    // CREATE INDEX
    const indexMatch = s.match(/CREATE INDEX IF NOT EXISTS (\w+)\s+ON\s+(\w+)\s*\((.+)\)/i);
    if (indexMatch) {
      const tableName = indexMatch[2];
      const fieldStr = indexMatch[3];
      const fields = fieldStr.split(',').map(f => {
        const match = f.trim().match(/^(\w+)/);
        return match ? match[1] : f.trim();
      });
      const indexDef = fields.reduce((obj, field) => { obj[field] = 1; return obj; }, {});
      try {
        await collection(tableName).createIndex(indexDef);
      } catch (e) { }
      continue;
    }

    // Simple DELETE FROM table
    const deleteMatch = s.match(/^DELETE FROM (\w+)$/i);
    if (deleteMatch) {
      const tableName = deleteMatch[1];
      await collection(tableName).deleteMany({});
      continue;
    }

    // INSERT OR IGNORE
    if (/^INSERT\s+OR\s+IGNORE/i.test(s)) {
      const insertMatch = s.match(/INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
      if (insertMatch) {
        const tableName = insertMatch[1];
        const fields = insertMatch[2].split(',').map(f => f.trim());
        const valuesStr = insertMatch[3];
        const values = valuesStr.split(',').map(v => {
          const t = v.trim();
          if (t === '?') return null;
          if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
          if (t.match(/^\d+$/)) return parseInt(t, 10);
          return t;
        });
        const doc = {};
        fields.forEach((f, i) => doc[f] = values[i]);
        try {
          await collection(tableName).insertOne(doc);
        } catch (e) { }
      }
      continue;
    }
  }
}

function transaction(fn) {
  return fn();
}

// Direct collection access for advanced operations
function getCollection(name) {
  return collection(name);
}

// Initialize collections and indexes
async function initCollections() {
  const database = getDB();

  const collections = [
    'admins', 'candidates', 'exam_records', 'exam_papers', 'exam_questions',
    'practical_submissions', 'practical_files', 'announcements', 'exam_settings',
    'operation_logs', 'proctor_events'
  ];

  for (const name of collections) {
    try {
      await database.createCollection(name);
    } catch (e) { }
  }

  // Indexes
  await database.collection('exam_papers').createIndex({ is_active: -1 });
  await database.collection('exam_papers').createIndex({ id: -1 });
  await database.collection('exam_questions').createIndex({ paper_id: 1 });
  await database.collection('exam_questions').createIndex({ id: 1 });
  await database.collection('practical_submissions').createIndex({ record_id: 1 }, { unique: true });
  await database.collection('practical_submissions').createIndex({ candidate_id: 1 });
  await database.collection('practical_files').createIndex({ submission_id: 1 });
  await database.collection('announcements').createIndex({ enabled: -1, pinned: -1, updated_at: -1 });
  await database.collection('exam_settings').createIndex({ key: 1 }, { unique: true });
  await database.collection('operation_logs').createIndex({ created_at: -1 });
  await database.collection('operation_logs').createIndex({ action: 1 });
  await database.collection('proctor_events').createIndex({ created_at: -1 });
  await database.collection('proctor_events').createIndex({ record_id: 1 });
  await database.collection('candidates').createIndex({ ticket_no: 1 }, { unique: true });
  await database.collection('candidates').createIndex({ id: 1 });
  await database.collection('exam_records').createIndex({ candidate_id: 1 });
  await database.collection('exam_records').createIndex({ status: 1 });
  await database.collection('exam_records').createIndex({ id: 1 });
  await database.collection('admins').createIndex({ username: 1 }, { unique: true });
}

module.exports = {
  connect,
  getDB,
  getCollection,
  collection,
  prepare,
  exec,
  transaction,
  initCollections
};
