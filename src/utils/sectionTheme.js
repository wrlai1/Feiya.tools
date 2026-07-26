export const SECTION_THEMES = {
  overview: {
    label: 'Overview',
    sidebar: 'bg-[#fff8ef]',
    sidebarActive: 'bg-[#fff1df]',
    itemActive: 'bg-white/80 text-[#9a4f16] shadow-sm',
    itemHover: 'hover:bg-white/65 hover:text-[#7f4214]',
    labelColor: 'text-[#b66a2f]',
    dot: 'bg-[#e49a5a]',
    page: 'bg-[#fffaf5]',
    header: 'bg-[#fffaf5]/90',
    border: 'border-[#f1dfca]',
    pill: 'bg-[#ffead2] text-[#9a4f16]',
  },
  operations: {
    label: 'Operations',
    sidebar: 'bg-[#f8f8f0]',
    sidebarActive: 'bg-[#eff3df]',
    itemActive: 'bg-white/80 text-[#5e6a24] shadow-sm',
    itemHover: 'hover:bg-white/65 hover:text-[#505b20]',
    labelColor: 'text-[#75813a]',
    dot: 'bg-[#96a356]',
    page: 'bg-[#fafbf5]',
    header: 'bg-[#fafbf5]/90',
    border: 'border-[#e3e8cf]',
    pill: 'bg-[#eaf0d4] text-[#5e6a24]',
  },
  insights: {
    label: 'Insights',
    sidebar: 'bg-[#faf7ff]',
    sidebarActive: 'bg-[#f1eaff]',
    itemActive: 'bg-white/80 text-[#7651a5] shadow-sm',
    itemHover: 'hover:bg-white/65 hover:text-[#65448f]',
    labelColor: 'text-[#8964b5]',
    dot: 'bg-[#a681cf]',
    page: 'bg-[#fcfaff]',
    header: 'bg-[#fcfaff]/90',
    border: 'border-[#e8def4]',
    pill: 'bg-[#eee4fa] text-[#7651a5]',
  },
  team: {
    label: 'Team',
    sidebar: 'bg-[#fff8f6]',
    sidebarActive: 'bg-[#ffebe8]',
    itemActive: 'bg-white/80 text-[#a34e44] shadow-sm',
    itemHover: 'hover:bg-white/65 hover:text-[#8d433b]',
    labelColor: 'text-[#b9685f]',
    dot: 'bg-[#d48176]',
    page: 'bg-[#fffaf9]',
    header: 'bg-[#fffaf9]/90',
    border: 'border-[#f0ddd9]',
    pill: 'bg-[#fbe4e0] text-[#a34e44]',
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
