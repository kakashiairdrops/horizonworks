'use strict';

const { get, run, all } = require('./db');
const { id } = require('./ids');
const { notFound, badRequest, forbidden } = require('./validate');

/** Marker for handlers that need to control status or headers. */
class ApiResponse {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

const created = (body) => new ApiResponse(201, body);
const noContent = () => new ApiResponse(204, null);

/** Reads a JSON body with a hard size cap. */
function readJsonBody(request, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(badRequest('Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(badRequest('Request body must be valid JSON.')); }
    });
    request.on('error', reject);
  });
}

const query = (url, key, fallback = '') => (url.searchParams.get(key) ?? fallback).toString().trim();

/**
 * Reads an integer query parameter.
 * A missing or non-numeric value yields the fallback — note that `Number(null)`
 * is 0, so the presence check must come first.
 */
function queryInt(url, key, fallback) {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function queryList(url, key) {
  return url.searchParams.getAll(key)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Resolves skill names to ids, creating nothing — unknown names are reported. */
function resolveSkillIds(db, names) {
  const ids = [];
  const unknown = [];
  for (const name of names) {
    const row = get(db, 'SELECT id FROM skills WHERE name = ? COLLATE NOCASE', [name]);
    if (row) ids.push(row.id);
    else unknown.push(name);
  }
  if (unknown.length) throw badRequest(`Unknown skills: ${unknown.join(', ')}.`);
  return ids;
}

const skillNamesFor = (db, table, column, value) =>
  all(db, `SELECT s.name FROM ${table} t JOIN skills s ON s.id = t.skill_id WHERE t.${column} = ? ORDER BY s.name`, [value])
    .map((row) => row.name);

function audit(db, actorId, action, entity, entityId, meta = {}) {
  run(db, `INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES (?, ?, ?, ?, ?)`,
    [actorId || null, action, entity, entityId, JSON.stringify(meta)]);
}

/** Loads a project the user is party to (client, talent, or admin). */
function projectForUser(db, projectId, user) {
  const project = get(db, `
    SELECT p.*, c.name AS client_name, c.company AS client_company, c.avatar_hue AS client_hue,
           t.name AS talent_name, t.avatar_hue AS talent_hue
    FROM projects p
    JOIN users c ON c.id = p.client_id
    JOIN users t ON t.id = p.talent_id
    WHERE p.id = ?`, [projectId]);
  if (!project) throw notFound('That project does not exist.');
  const isParty = project.client_id === user.id || project.talent_id === user.id || user.role === 'admin';
  if (!isParty) throw forbidden('You are not part of this project.');
  return project;
}

const newId = id;

module.exports = {
  ApiResponse, created, noContent, readJsonBody,
  query, queryInt, queryList, resolveSkillIds, skillNamesFor, audit, projectForUser, newId
};
