import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LABEL_COLORS,
  REGION_PATTERN,
  ROLE_ARN_PATTERN,
  type ActiveRole,
  type AppState,
  type Favourite,
  type HistoryEntry,
  type LabelColor,
  type ProfileLabel,
  type Settings,
} from '../../shared/types';

const HISTORY_LIMIT = 200;
const FAVOURITES_LIMIT = 100;
const RECENT_ROLES_LIMIT = 8;

/** Where the dashboard keeps its own settings. It never writes inside ~/.aws. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AWS_DASHBOARD_DATA_DIR) return env.AWS_DASHBOARD_DATA_DIR;
  if (process.platform === 'win32') {
    return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'aws-console-dashboard');
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'aws-console-dashboard');
}

function emptyState(): AppState {
  return { settings: { pins: [], labels: {} }, history: [], favourites: [] };
}

function text(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined;
}

/** Applies a settings change coming from outside, keeping only values of the expected shape. */
export function cleanSettings(input: unknown, base: Settings): Settings {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const next: Settings = { ...base, pins: [...base.pins], labels: { ...base.labels } };

  if ('activeProfile' in src) next.activeProfile = text(src.activeProfile, 200);
  if ('region' in src) {
    const region = text(src.region, 30);
    next.region = region && REGION_PATTERN.test(region) ? region : undefined;
  }
  if (Array.isArray(src.pins)) {
    next.pins = [...new Set(src.pins.filter((p): p is string => text(p, 200) !== undefined))].slice(0, 500);
  }
  if (src.labels && typeof src.labels === 'object') {
    const labels: Record<string, ProfileLabel> = {};
    for (const [name, raw] of Object.entries(src.labels as Record<string, unknown>)) {
      const label = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      if (LABEL_COLORS.includes(label.color as LabelColor)) {
        labels[name] = { color: label.color as LabelColor, text: text(label.text, 24) };
      }
    }
    next.labels = labels;
  }
  if ('allRegions' in src) next.allRegions = src.allRegions === true ? true : undefined;
  if ('activeRole' in src) next.activeRole = cleanRole(src.activeRole);
  if (Array.isArray(src.recentRoles)) {
    next.recentRoles = src.recentRoles
      .map(cleanRole)
      .filter((role): role is ActiveRole => role !== undefined)
      .slice(0, RECENT_ROLES_LIMIT);
  }
  return next;
}

function cleanRole(input: unknown): ActiveRole | undefined {
  const item = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const profile = text(item.profile, 200);
  const arn = text(item.arn, 700);
  return profile && arn && ROLE_ARN_PATTERN.test(arn) ? { profile, arn } : undefined;
}

function cleanFavourites(input: unknown): Favourite[] {
  if (!Array.isArray(input)) return [];
  const result: Favourite[] = [];
  for (const raw of input) {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = text(item.name, 80);
    const command = text(item.command, 20_000);
    if (name && command) result.push({ name, command });
  }
  return result.slice(0, FAVOURITES_LIMIT);
}

function cleanHistory(input: unknown): HistoryEntry[] {
  if (!Array.isArray(input)) return [];
  const result: HistoryEntry[] = [];
  for (const raw of input) {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const profile = text(item.profile, 200);
    const command = text(item.command, 20_000);
    const at = text(item.at, 40);
    if (!profile || !command || !at) continue;
    const role = text(item.role, 700);
    result.push({
      profile,
      command,
      at,
      role: role && ROLE_ARN_PATTERN.test(role) ? role : undefined,
      region: text(item.region, 30),
      exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
    });
  }
  return result.slice(0, HISTORY_LIMIT);
}

/** Settings, command history and favourites, kept in one JSON file on this computer. */
export class Store {
  private state: AppState;
  private readonly file: string;

  constructor(readonly dir: string = defaultDataDir()) {
    this.file = join(dir, 'state.json');
    this.state = this.load();
  }

  private load(): AppState {
    const state = emptyState();
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      state.settings = cleanSettings(raw.settings, state.settings);
      state.history = cleanHistory(raw.history);
      state.favourites = cleanFavourites(raw.favourites);
    } catch {
      // No file yet, or it is unreadable: start with empty settings.
    }
    return state;
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2));
    renameSync(temp, this.file);
  }

  get snapshot(): AppState {
    return this.state;
  }

  updateSettings(patch: unknown): Settings {
    this.state.settings = cleanSettings(patch, this.state.settings);
    this.save();
    return this.state.settings;
  }

  addHistory(entry: HistoryEntry): void {
    const others = this.state.history.filter(
      (h) => !(h.profile === entry.profile && h.role === entry.role && h.command === entry.command),
    );
    this.state.history = [entry, ...others].slice(0, HISTORY_LIMIT);
    this.save();
  }

  clearHistory(): void {
    this.state.history = [];
    this.save();
  }

  setFavourites(input: unknown): Favourite[] {
    this.state.favourites = cleanFavourites(input);
    this.save();
    return this.state.favourites;
  }
}
