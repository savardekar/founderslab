/** Navigation architecture. Entries with enabled:false belong to later phases and are not rendered yet. */
export type NavItem = { id: string; label: string; href: string; icon: string; needs?: string; enabled: boolean; phase: number };
export const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', href: 'dashboard', icon: '▦', enabled: true, phase: 1 },
  { id: 'builder', label: 'Company Builder', href: 'builder', icon: '✦', needs: 'roles.create', enabled: true, phase: 1 },
  { id: 'organization', label: 'Organization', href: 'organization', icon: '⌥', needs: 'roles.view', enabled: true, phase: 1 },
  { id: 'roles', label: 'Roles', href: 'roles', icon: '◈', needs: 'roles.view', enabled: true, phase: 1 },
  { id: 'departments', label: 'Departments', href: 'departments', icon: '▤', needs: 'departments.view', enabled: true, phase: 1 },
  { id: 'employees', label: 'Employees', href: 'employees', icon: '☺', needs: 'members.view', enabled: true, phase: 1 },
  { id: 'ai-employees', label: 'AI Employees', href: 'ai-employees', icon: '◉', needs: 'agents.view', enabled: true, phase: 2 },
  { id: 'tasks', label: 'Tasks', href: 'tasks', icon: '✓', enabled: true, phase: 3 },
  { id: 'projects', label: 'Projects', href: 'projects', icon: '▣', enabled: true, phase: 3 },
  { id: 'performance', label: 'Performance', href: 'performance', icon: '↗', enabled: true, phase: 3 },
  { id: 'reports', label: 'Reports', href: 'reports', icon: '▥', enabled: true, phase: 3 },
  { id: 'workforce', label: 'Workforce', href: 'workforce', icon: '☷', needs: 'roles.view', enabled: true, phase: 2 },
  { id: 'settings', label: 'Settings', href: 'settings', icon: '⚙', needs: 'company.view', enabled: true, phase: 1 },
  // Prepared, not built:
  { id: 'knowledge', label: 'Knowledge Base', href: 'knowledge', icon: '❖', enabled: false, phase: 4 },
  { id: 'decisions', label: 'Decisions', href: 'decisions', icon: '⚖', enabled: false, phase: 4 },
  { id: 'workflows', label: 'Workflows', href: 'workflows', icon: '⇄', enabled: false, phase: 5 },
  { id: 'approvals', label: 'Approvals', href: 'approvals', icon: '✔', enabled: false, phase: 5 },
];
