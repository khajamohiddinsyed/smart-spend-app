// Screen state shared by the views, sheets and router (not persisted).
import { todayDate, todayISO } from './core.js';

const t = todayDate();
export const ui = {
  tab: 'home',
  profile: null,                    // the unlocked profile object
  month: { y: t.getFullYear(), m: t.getMonth() },
  selected: todayISO(),
  scope: 'month',                   // activity: 'day' | 'month' | 'all'
  filter: 'all',                    // 'all' | 'in' | 'out'
  account: 'all',                   // 'all', an account label, or '' for entries without one
  category: 'all',                  // 'all' or a category id (Activity filter)
  expanded: {},                     // category id -> true, expanded rows in Insights 'Where it went'
  rangeFrom: null, rangeTo: null,   // for scope 'range' (set by Ask -> See all)
  cardsOnly: false,                 // Activity: show only card entries (set by Ask -> See all)
  search: '',
  flash: {},                        // ids to highlight after add/edit
  install: null,                    // deferred install prompt, when the browser offers one
  standalone: false
};

export function resetScreenState() {
  const n = todayDate();
  ui.month = { y: n.getFullYear(), m: n.getMonth() };
  ui.selected = todayISO();
  ui.scope = 'month';
  ui.filter = 'all';
  ui.rangeFrom = null; ui.rangeTo = null; ui.cardsOnly = false;
  ui.account = 'all';
  ui.category = 'all';
  ui.expanded = {};
  ui.search = '';
  ui.flash = {};
}
