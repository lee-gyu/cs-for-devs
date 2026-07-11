import { getPhaseGroups } from '../navigation';

export default {
  watch: 'ch-*/*.md',
  load() {
    return getPhaseGroups();
  },
};
