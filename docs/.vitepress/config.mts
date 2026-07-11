import { defineConfig } from 'vitepress';
import { buildNav, buildSidebar } from './navigation';

export default defineConfig({
  lang: 'ko-KR',
  base: '/cs-for-devs/',
  title: 'CS for DEV',
  description: 'Learning CS for every Developer',
  cleanUrls: true,
  lastUpdated: true,
  markdown: {
    image: {
      lazyLoading: true,
    },
  },
  head: [
    [
      'link',
      {
        rel: 'stylesheet',
        as: 'style',
        crossorigin: '',
        href: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css',
      },
    ],
  ],
  sitemap: {
    hostname: 'https://lee-gyu.github.io/cs-for-devs/',
  },
  srcExclude: ['README.md'],
  themeConfig: {
    nav: buildNav(),
    sidebar: buildSidebar(),
    outline: {
      level: [2, 3],
      label: 'Table of Contents',
    },
    search: {
      provider: 'local',
    },
    docFooter: {
      prev: 'Prev',
      next: 'Next',
    },
    lastUpdated: {
      text: 'Last Updated',
      formatOptions: {
        dateStyle: 'medium',
        timeStyle: 'short',
      },
    },
    editLink: {
      pattern: 'https://github.com/lee-gyu/cs-for-devs/edit/main/docs/:path',
      text: 'Edit on GitHub',
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/lee-gyu/cs-for-devs' },
    ],
    returnToTopLabel: 'To Top',
    sidebarMenuLabel: 'Doc Menu',
    darkModeSwitchLabel: 'Theme',
    lightModeSwitchTitle: 'To Light Mode',
    darkModeSwitchTitle: 'To Dark Mode',
  },
});
