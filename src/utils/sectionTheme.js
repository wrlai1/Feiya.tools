export const SECTION_THEMES = {
  overview: {
    label: 'Overview',
    sidebar: 'bg-transparent',
    sidebarActive: 'bg-[#f1f5f7]',
    itemActive: 'bg-white text-[#38586a] shadow-sm ring-1 ring-[#dde6ea]',
    itemHover: 'hover:bg-[#f4f7f8] hover:text-[#38586a]',
    labelColor: 'text-[#667c88]',
    dot: 'bg-[#537386]',
    connector: 'bg-[#537386]',
    page: 'bg-[#f6f8f9]',
    header: 'bg-[#fafbfc]/90',
    border: 'border-[#e3e8eb]',
  },
  operations: {
    label: 'Operations',
    sidebar: 'bg-transparent',
    sidebarActive: 'bg-[#f3f5ef]',
    itemActive: 'bg-white text-[#5c6853] shadow-sm ring-1 ring-[#e0e5da]',
    itemHover: 'hover:bg-[#f5f7f2] hover:text-[#515d49]',
    labelColor: 'text-[#747f6c]',
    dot: 'bg-[#74806b]',
    connector: 'bg-[#74806b]',
    page: 'bg-[#f8f9f6]',
    header: 'bg-[#fbfcfa]/90',
    border: 'border-[#e4e8df]',
  },
  insights: {
    label: 'Insights',
    sidebar: 'bg-transparent',
    sidebarActive: 'bg-[#f3f1f6]',
    itemActive: 'bg-white text-[#625a73] shadow-sm ring-1 ring-[#e2dfe8]',
    itemHover: 'hover:bg-[#f6f4f8] hover:text-[#5c546d]',
    labelColor: 'text-[#777084]',
    dot: 'bg-[#746b86]',
    connector: 'bg-[#746b86]',
    page: 'bg-[#f8f7fa]',
    header: 'bg-[#fbfafc]/90',
    border: 'border-[#e5e2e9]',
  },
  team: {
    label: 'Team',
    sidebar: 'bg-transparent',
    sidebarActive: 'bg-[#f7f1ef]',
    itemActive: 'bg-white text-[#806158] shadow-sm ring-1 ring-[#eadfdb]',
    itemHover: 'hover:bg-[#f9f5f3] hover:text-[#76584f]',
    labelColor: 'text-[#8b7169]',
    dot: 'bg-[#8f6e64]',
    connector: 'bg-[#8f6e64]',
    page: 'bg-[#faf8f7]',
    header: 'bg-[#fcfbfa]/90',
    border: 'border-[#ebe3e0]',
  },
}

export function sectionThemeForPath(pathname) {
  if (pathname === '/') return SECTION_THEMES.overview
  if (pathname.startsWith('/analytics') || pathname.startsWith('/new-products')) {
    return SECTION_THEMES.insights
  }
  if (pathname.startsWith('/timeclock') || pathname.startsWith('/users') || pathname.startsWith('/time-report')) {
    return SECTION_THEMES.team
  }
  return SECTION_THEMES.operations
}
