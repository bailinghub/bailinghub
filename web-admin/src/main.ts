import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { ElAlert } from 'element-plus/es/components/alert/index';
import { ElButton } from 'element-plus/es/components/button/index';
import { ElCard } from 'element-plus/es/components/card/index';
import { ElCheckbox } from 'element-plus/es/components/checkbox/index';
import { ElCollapse, ElCollapseItem } from 'element-plus/es/components/collapse/index';
import { ElColorPicker } from 'element-plus/es/components/color-picker/index';
import { ElConfigProvider } from 'element-plus/es/components/config-provider/index';
import { ElAside, ElContainer, ElHeader, ElMain } from 'element-plus/es/components/container/index';
import { ElDescriptions, ElDescriptionsItem } from 'element-plus/es/components/descriptions/index';
import { ElDialog } from 'element-plus/es/components/dialog/index';
import { ElDivider } from 'element-plus/es/components/divider/index';
import { ElDrawer } from 'element-plus/es/components/drawer/index';
import { ElDropdown, ElDropdownItem, ElDropdownMenu } from 'element-plus/es/components/dropdown/index';
import { ElEmpty } from 'element-plus/es/components/empty/index';
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index';
import { ElIcon } from 'element-plus/es/components/icon/index';
import { ElImage } from 'element-plus/es/components/image/index';
import { ElInput } from 'element-plus/es/components/input/index';
import { ElInputNumber } from 'element-plus/es/components/input-number/index';
import { ElLoading } from 'element-plus/es/components/loading/index';
import { ElMenu, ElMenuItem, ElSubMenu } from 'element-plus/es/components/menu/index';
import { ElPopconfirm } from 'element-plus/es/components/popconfirm/index';
import { ElPopover } from 'element-plus/es/components/popover/index';
import { ElProgress } from 'element-plus/es/components/progress/index';
import { ElRadio, ElRadioButton, ElRadioGroup } from 'element-plus/es/components/radio/index';
import { ElOption, ElOptionGroup, ElSelect } from 'element-plus/es/components/select/index';
import { ElStatistic } from 'element-plus/es/components/statistic/index';
import { ElSwitch } from 'element-plus/es/components/switch/index';
import { ElTable, ElTableColumn } from 'element-plus/es/components/table/index';
import { ElTabPane, ElTabs } from 'element-plus/es/components/tabs/index';
import { ElTag } from 'element-plus/es/components/tag/index';
import { ElTimeline, ElTimelineItem } from 'element-plus/es/components/timeline/index';
import { ElTooltip } from 'element-plus/es/components/tooltip/index';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import App from './App.vue';
import { router } from './router';
import { installTableWidthPersistence } from './table-widths';
import './styles/base.css';

sessionStorage.removeItem('bailing:console:asset-reload:v1');

// 下拉面板统一锁定为输入框宽度（配合 base.css 的选项折行）：
// 否则带长说明的选项把面板撑得比输入框宽，在贴屏幕右缘的抽屉里 popper 放不下会把面板横移，
// 看起来就是"有的向下展开、有的向左展开"不一致。改 prop 全局默认值，所有页面一次统一。
(ElSelect.props as Record<string, unknown>)['fitInputWidth'] = { type: Boolean, default: true };
// 后台所有列表统一支持拖拽列宽：Element Plus 的列拖拽依赖 table border 暴露列分隔线；
// 各页面仍可显式传 :border="false" 或 :resizable="false" 覆盖。
(ElTable.props as Record<string, unknown>)['border'] = { type: Boolean, default: true };
(ElTable.props as Record<string, unknown>)['allowDragLastColumn'] = { type: Boolean, default: false };
(ElTableColumn.props as Record<string, unknown>)['resizable'] = { type: Boolean, default: true };

const app = createApp(App);
[
  ElAlert,
  ElAside,
  ElButton,
  ElCard,
  ElCheckbox,
  ElCollapse,
  ElCollapseItem,
  ElColorPicker,
  ElConfigProvider,
  ElContainer,
  ElDescriptions,
  ElDescriptionsItem,
  ElDialog,
  ElDivider,
  ElDrawer,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElHeader,
  ElIcon,
  ElImage,
  ElInput,
  ElInputNumber,
  ElMain,
  ElMenu,
  ElMenuItem,
  ElSubMenu,
  ElOption,
  ElOptionGroup,
  ElPopconfirm,
  ElPopover,
  ElProgress,
  ElRadio,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElStatistic,
  ElSwitch,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
  ElTimeline,
  ElTimelineItem,
  ElTooltip,
].forEach((component) => app.component(component.name, component));
app.directive('loading', ElLoading.directive);
installTableWidthPersistence(app, router);

app.use(createPinia()).use(router).mount('#app');
