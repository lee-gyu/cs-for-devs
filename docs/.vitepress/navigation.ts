import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefaultTheme } from 'vitepress';

export interface PhaseDoc {
  phase: number;
  order: number;
  title: string;
  shortTitle: string;
  link: string;
}

export interface PhaseGroup {
  id: string;
  phase: number;
  sortOrder: number;
  text: string;
  activeMatch: string;
  docs: PhaseDoc[];
}

const docsRoot = fileURLToPath(new URL('..', import.meta.url));
const phaseDirectoryPattern = /^ch-(\d+)([a-z]?)$/;
const documentFilePattern = /^(\d+)-.+\.md$/;
const headingPattern = /^#\s+(.+?)\s*$/m;

const PHASE_LABELS: Record<string, string> = {
  '0': '챕터 0 — CS를 배우는 이유',
  '1': '챕터 1 — 자료구조와 알고리즘',
  '4': '챕터 4 — 언어 이론과 타입 시스템',
  '5': '챕터 5 — 컴파일러와 인터프리터',
  '6': '챕터 6 — 런타임과 메모리',
  '7': '챕터 7 — 컴퓨터 구조',
  '8': '챕터 8 — 운영체제',
  '9': '챕터 9 — 네트워크',
  '11': '챕터 11 — 데이터베이스 시스템 내부와 실행 진단',
  '13': '챕터 13 — 요구사항과 설계',
  '14': '챕터 14 — 품질과 신뢰성',
};

function phaseLabel(phaseId: string): string {
  return PHASE_LABELS[phaseId] ?? `Phase ${phaseId}`;
}

function phaseSortOrder(phase: number, suffix: string): number {
  if (!suffix) {
    return phase;
  }

  return phase + (suffix.charCodeAt(0) - 'a'.charCodeAt(0) + 1) / 100;
}

function directoryConfig(name: string): Omit<PhaseGroup, 'docs'> | null {
  const phaseMatch = name.match(phaseDirectoryPattern);

  if (!phaseMatch) {
    return null;
  }

  const phase = Number(phaseMatch[1]);
  const suffix = phaseMatch[2] ?? '';
  const phaseId = `${phase}${suffix}`;

  return {
    id: name,
    phase,
    sortOrder: phaseSortOrder(phase, suffix),
    text: phaseLabel(phaseId),
    activeMatch: `/${name}/`,
  };
}

function trimTitle(title: string): string {
  return title.split(/\s+[—-]\s+|:\s+/)[0] ?? title;
}

function readDocumentTitle(filePath: string): string {
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(headingPattern);

  if (!match) {
    throw new Error(`Missing first-level heading: ${filePath}`);
  }

  return match[1].trim();
}

export function getPhaseGroups(): PhaseGroup[] {
  if (!existsSync(docsRoot)) {
    return [];
  }

  return readdirSync(docsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const config = directoryConfig(entry.name);
      return config ? { name: entry.name, config } : null;
    })
    .filter((entry): entry is { name: string; config: Omit<PhaseGroup, 'docs'> } => entry !== null)
    .sort((a, b) => a.config.sortOrder - b.config.sortOrder)
    .map(({ name, config }) => {
      const phasePath = join(docsRoot, name);
      const docs = readdirSync(phasePath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => {
          const match = entry.name.match(documentFilePattern);

          if (!match) {
            throw new Error(
              `Phase document filename must start with a numeric prefix: ${join(name, entry.name)}`,
            );
          }

          const order = Number(match[1]);
          const title = readDocumentTitle(join(phasePath, entry.name));
          const slug = basename(entry.name, '.md');

          return {
            phase: config.phase,
            order,
            title,
            shortTitle: trimTitle(title),
            link: `/${name}/${slug}`,
          };
        })
        .sort((a, b) => a.order - b.order);

      return {
        ...config,
        docs,
      };
    })
    .filter((group) => group.docs.length > 0);
}

export function buildNav(): DefaultTheme.NavItem[] {
  const documentItems: DefaultTheme.NavItemWithLink[] = getPhaseGroups().map((group) => ({
    text: group.text,
    link: group.docs[0].link,
    activeMatch: group.activeMatch,
  }));

  return [
    { text: '홈', link: '/' },
    { text: '문서', items: documentItems }
  ];
}

export function buildSidebar(): DefaultTheme.SidebarItem[] {
  return getPhaseGroups().map((group) => ({
    text: group.text,
    collapsed: false,
    items: group.docs.map((doc) => ({
      text: doc.shortTitle,
      link: doc.link,
    })),
  }));
}
