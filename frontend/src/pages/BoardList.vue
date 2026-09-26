<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import FilterBar from '../components/common/FilterBar.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import DimensionChart from '../components/common/DimensionChart.vue';
import { useBoardStore, PairConflictError, SwapBlockedError } from '../stores/boardStore';
import { useChamberStore } from '../stores/chamberStore';
import { useGuqinFilter } from '../hooks/useGuqinFilter';
import { thicknessGap, suggestGuqinNo } from '../utils/wood';
import { formatDate } from '../utils/layer';
import {
  BOARD_PARTS,
  WOOD_DEFECTS,
  WOOD_GRAINS,
  WOOD_SPECIES,
  type BoardPart,
  type WoodBoard,
  type WoodDefect,
  type WoodGrain,
  type WoodSpecies,
} from '../types/wood-board';

const boardStore = useBoardStore();
const chamberStore = useChamberStore();
const filter = useGuqinFilter();

const dialogVisible = ref(false);
const editingId = ref('');
const formRef = ref<FormInstance>();
const selectedGuqin = ref('');

interface BoardForm {
  boardNo: string;
  part: BoardPart;
  species: WoodSpecies;
  dryYears: number;
  thicknessMm: number;
  grain: WoodGrain;
  defect: WoodDefect;
  receivedAt: string;
  remark: string;
}

const form = ref<BoardForm>({
  boardNo: '',
  part: '面板',
  species: '桐木',
  dryYears: 5,
  thicknessMm: 30,
  grain: '直纹',
  defect: '无',
  receivedAt: new Date().toISOString().slice(0, 10),
  remark: '',
});

const rules: FormRules = {
  boardNo: [{ required: true, message: '请输入板材号', trigger: 'blur' }],
};

const visible = computed(() => filter.applyBoards(boardStore.boards));
const visiblePairs = computed(() => {
  const nos = new Set(visible.value.map((b) => b.guqinNo).filter(Boolean));
  return boardStore.pairs.filter((pair) => nos.has(pair.guqinNo));
});

/** 待配对池：只受树种 / 关键字筛选影响（按琴号筛选时待配板不归属任何琴） */
const pendingVisible = computed(() => {
  const species = filter.species.value;
  const kw = filter.keyword.value.trim().toLowerCase();
  return boardStore.pendingBoards.filter((board) => {
    if (species && board.species !== species) return false;
    if (kw && !`${board.boardNo} ${board.species} ${board.remark ?? ''}`.toLowerCase().includes(kw)) return false;
    return true;
  });
});
const pendingPanels = computed(() => pendingVisible.value.filter((b) => b.part === '面板'));
const pendingBases = computed(() => pendingVisible.value.filter((b) => b.part === '底板'));

const chartMarks = computed(() => (selectedGuqin.value ? chamberStore.marksOf(selectedGuqin.value) : []));
const chartDepth = computed(() => chamberStore.byGuqin(selectedGuqin.value)?.chamberDepth ?? 0);

function boardLabel(board: WoodBoard): string {
  return `${board.boardNo} · ${board.species} · ${board.thicknessMm}mm · 阴干${board.dryYears}年${board.defect !== '无' ? ` · ${board.defect}` : ''}`;
}

function openCreate() {
  editingId.value = '';
  form.value = {
    boardNo: `MB-${Date.now().toString().slice(-4)}`,
    part: '面板',
    species: '桐木',
    dryYears: 5,
    thicknessMm: 30,
    grain: '直纹',
    defect: '无',
    receivedAt: new Date().toISOString().slice(0, 10),
    remark: '',
  };
  dialogVisible.value = true;
}

const editingBoard = computed(() => boardStore.boards.find((b) => b.id === editingId.value));

function openEdit(board: WoodBoard) {
  editingId.value = board.id;
  form.value = {
    boardNo: board.boardNo,
    part: board.part,
    species: board.species,
    dryYears: board.dryYears,
    thicknessMm: board.thicknessMm,
    grain: board.grain,
    defect: board.defect,
    receivedAt: board.receivedAt.slice(0, 10),
    remark: board.remark ?? '',
  };
  dialogVisible.value = true;
}

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;
  const payload = {
    boardNo: form.value.boardNo,
    part: form.value.part,
    species: form.value.species,
    dryYears: Number(form.value.dryYears) || 0,
    thicknessMm: Number(form.value.thicknessMm) || 0,
    grain: form.value.grain,
    defect: form.value.defect,
    receivedAt: new Date(`${form.value.receivedAt}T09:00:00`).toISOString(),
    remark: form.value.remark,
  };
  if (editingId.value) {
    await boardStore.updateBoard(editingId.value, payload);
    ElMessage.success(`已更新板材 ${payload.boardNo}`);
  } else {
    await boardStore.addBoard(payload);
    ElMessage.success(`已登记板材 ${payload.boardNo}（${payload.part}），已进入待配对池`);
  }
  dialogVisible.value = false;
}

async function remove(board: WoodBoard) {
  const confirmed = await ElMessageBox.confirm(`确认删除板材 ${board.boardNo}？`, '删除确认', { type: 'warning' })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await boardStore.removeBoard(board.id);
  ElMessage.success('已删除');
}

/* ---------------- 配对成一副 ---------------- */

const pairVisible = ref(false);
const pairPanelId = ref('');
const pairBaseId = ref('');
const pairGuqinNo = ref('');

const suggestedNo = computed(() => suggestGuqinNo(boardStore.guqinNos));
const guqinOptions = computed(() => Array.from(new Set([...boardStore.guqinNos, suggestedNo.value])));

function openPair(preset?: WoodBoard) {
  pairPanelId.value = preset?.part === '面板' ? preset.id : '';
  pairBaseId.value = preset?.part === '底板' ? preset.id : '';
  pairGuqinNo.value = suggestedNo.value;
  pairVisible.value = true;
}

/** 所选琴号当前的占用板材（面板/底板各最多一块），配对前提示冲突 */
const pairOccupants = computed(() => {
  const no = pairGuqinNo.value.trim();
  if (!no) return { panel: undefined as WoodBoard | undefined, base: undefined as WoodBoard | undefined };
  const list = boardStore.boards.filter((b) => b.guqinNo === no);
  return { panel: list.find((b) => b.part === '面板'), base: list.find((b) => b.part === '底板') };
});
const pairBlocked = computed(() => Boolean(pairOccupants.value.panel || pairOccupants.value.base));
const pairReady = computed(() => Boolean(pairPanelId.value && pairBaseId.value && pairGuqinNo.value.trim() && !pairBlocked.value));

async function submitPair() {
  if (!pairPanelId.value || !pairBaseId.value) {
    ElMessage.warning('请各挑一块面板和一块底板');
    return;
  }
  if (!pairGuqinNo.value.trim()) {
    ElMessage.warning('请填写琴号');
    return;
  }
  try {
    await boardStore.createPair(pairPanelId.value, pairBaseId.value, pairGuqinNo.value);
    ElMessage.success(`已配对成一副：${pairGuqinNo.value.trim()}（面板 + 底板共用此琴号）`);
    pairVisible.value = false;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '配对失败');
  }
}

/* ---------------- 补空缺 / 换板 ---------------- */

const assignVisible = ref(false);
const assignPart = ref<BoardPart>('面板');
const assignGuqinNo = ref('');
const assignBoardId = ref('');

function openAssign(guqinNo: string, part: BoardPart) {
  assignPart.value = part;
  assignGuqinNo.value = guqinNo;
  assignBoardId.value = boardStore.pendingBoards.find((b) => b.part === part)?.id ?? '';
  assignVisible.value = true;
}

const assignOccupant = computed(() =>
  boardStore.boards.find((b) => b.guqinNo === assignGuqinNo.value && b.part === assignPart.value),
);
const assignCandidates = computed(() => boardStore.pendingBoards.filter((b) => b.part === assignPart.value));
/** 换板（该部位已有板材）时，掏膛 / 髹漆记录会阻断操作 */
const assignBlockReasons = computed(() =>
  assignOccupant.value ? boardStore.blockSwapReasons(assignGuqinNo.value) : [],
);
const assignReady = computed(() => Boolean(assignBoardId.value && assignBlockReasons.value.length === 0));

async function submitAssign() {
  if (!assignBoardId.value) {
    ElMessage.warning(`请挑选一块待配对的${assignPart.value}`);
    return;
  }
  try {
    const result = await boardStore.assignBoard(assignBoardId.value, assignGuqinNo.value);
    if (result?.released) {
      ElMessage.success(`已换板：新${assignPart.value}接管琴号 ${assignGuqinNo.value}，原板材 ${result.released.boardNo} 已退回待配对`);
    } else {
      ElMessage.success(`${assignPart.value}已补入琴号 ${assignGuqinNo.value}`);
    }
    assignVisible.value = false;
  } catch (error) {
    if (error instanceof PairConflictError) {
      ElMessage.error(`无法安排：${error.message}`);
    } else if (error instanceof SwapBlockedError) {
      ElMessage.error(error.reasons.join('；'));
    } else {
      ElMessage.error(error instanceof Error ? error.message : '操作失败');
    }
  }
}

/** 配对表里的重复冲突板材退回待配对池 */
async function releaseConflict(board: WoodBoard) {
  const confirmed = await ElMessageBox.confirm(
    `把板材 ${board.boardNo} 退回待配对池？它将不再占用琴号 ${board.guqinNo}。`,
    '退回待配对',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await boardStore.releaseToPending(board.id);
  ElMessage.success(`板材 ${board.boardNo} 已退回待配对`);
}
</script>

<template>
  <div>
    <h2 class="page-title">板材登记与配对</h2>
    <p class="page-desc">板材先登记进待配对池，再挑一块面板和一块底板配对成一副、共用同一琴号；同部位不接受第二块板，换板时旧板自动退回待配对。</p>

    <div class="toolbar">
      <el-button type="primary" @click="openCreate">登记板材</el-button>
      <el-button type="success" @click="openPair()">配对成一副</el-button>
      <el-button @click="selectedGuqin = boardStore.guqinNos[0] ?? ''">查看首张琴剖面</el-button>
    </div>

    <FilterBar
      :fields="[
        { key: 'guqin', label: '琴号', options: boardStore.guqinNos, width: 130 },
        { key: 'species', label: '树种', options: WOOD_SPECIES, width: 110 },
      ]"
      :result-count="visible.length"
      :total-count="boardStore.boards.length"
    />

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">
          <span>面板 / 底板配对（含水率回显）</span>
          <el-button link type="primary" @click="openPair()">配对成一副</el-button>
        </div>
      </template>
      <el-table :data="visiblePairs" size="small" border>
        <el-table-column prop="guqinNo" label="琴号" width="100" />
        <el-table-column label="面板" min-width="210">
          <template #default="scope">
            <template v-if="scope.row.panel">
              <div>{{ scope.row.panel.boardNo }} · {{ scope.row.panel.species }} · {{ scope.row.panel.thicknessMm }}mm</div>
              <el-button link type="primary" size="small" @click="openAssign(scope.row.guqinNo, '面板')">换板</el-button>
            </template>
            <template v-else>
              <el-tag type="danger" size="small">缺面板</el-tag>
              <el-button link type="primary" size="small" @click="openAssign(scope.row.guqinNo, '面板')">补面板</el-button>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="底板" min-width="210">
          <template #default="scope">
            <template v-if="scope.row.base">
              <div>{{ scope.row.base.boardNo }} · {{ scope.row.base.species }} · {{ scope.row.base.thicknessMm }}mm</div>
              <el-button link type="primary" size="small" @click="openAssign(scope.row.guqinNo, '底板')">换板</el-button>
            </template>
            <template v-else>
              <el-tag type="danger" size="small">缺底板</el-tag>
              <el-button link type="primary" size="small" @click="openAssign(scope.row.guqinNo, '底板')">补底板</el-button>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="含水率" width="90">
          <template #default="scope">{{ scope.row.moisturePct }}%</template>
        </el-table-column>
        <el-table-column label="板厚差(mm)" width="100">
          <template #default="scope">{{ thicknessGap(scope.row) }}</template>
        </el-table-column>
        <el-table-column label="配对状态" width="100">
          <template #default="scope">
            <el-tag :type="scope.row.matched ? 'success' : 'warning'" size="small">{{ scope.row.matched ? '已配对' : '待配对' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="同部位冲突" min-width="180">
          <template #default="scope">
            <template v-if="scope.row.conflict">
              <el-tag
                v-for="b in [...scope.row.extraPanels, ...scope.row.extraBases]"
                :key="b.id"
                type="danger"
                size="small"
                class="conflict-tag"
              >
                {{ b.part }} {{ b.boardNo }} 重复
                <el-button link type="danger" size="small" @click="releaseConflict(b)">退回</el-button>
              </el-tag>
            </template>
            <el-tag v-else type="success" size="small">无冲突</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="scope">
            <el-button link type="primary" @click="selectedGuqin = scope.row.guqinNo">剖面标注</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="visiblePairs.length === 0" :image-size="60" description="还没有配对成副的琴，点击右上角「配对成一副」开始" />
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">
          <span>待配对池（尚未占用琴号的板材）</span>
          <span class="card-note">面板 {{ boardStore.pendingPanels.length }} 块 · 底板 {{ boardStore.pendingBases.length }} 块</span>
        </div>
      </template>
      <el-row :gutter="12">
        <el-col :xs="24" :md="12">
          <div class="pool-title">待配对面板（{{ pendingPanels.length }}）</div>
          <el-table :data="pendingPanels" size="small" border>
            <el-table-column prop="boardNo" label="板材号" width="110" />
            <el-table-column prop="species" label="树种" width="70" />
            <el-table-column label="厚度" width="70">
              <template #default="scope">{{ scope.row.thicknessMm }}mm</template>
            </el-table-column>
            <el-table-column prop="defect" label="缺陷" width="70" />
            <el-table-column label="操作" width="80">
              <template #default="scope">
                <el-button link type="primary" size="small" @click="openPair(scope.row)">配对</el-button>
              </template>
            </el-table-column>
            <template #empty><el-empty :image-size="40" description="暂无待配对面板" /></template>
          </el-table>
        </el-col>
        <el-col :xs="24" :md="12">
          <div class="pool-title">待配对底板（{{ pendingBases.length }}）</div>
          <el-table :data="pendingBases" size="small" border>
            <el-table-column prop="boardNo" label="板材号" width="110" />
            <el-table-column prop="species" label="树种" width="70" />
            <el-table-column label="厚度" width="70">
              <template #default="scope">{{ scope.row.thicknessMm }}mm</template>
            </el-table-column>
            <el-table-column prop="defect" label="缺陷" width="70" />
            <el-table-column label="操作" width="80">
              <template #default="scope">
                <el-button link type="primary" size="small" @click="openPair(scope.row)">配对</el-button>
              </template>
            </el-table-column>
            <template #empty><el-empty :image-size="40" description="暂无待配对底板" /></template>
          </el-table>
        </el-col>
      </el-row>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>板材明细</template>
      <el-table :data="visible" size="small" border>
        <el-table-column prop="boardNo" label="板材号" width="120" />
        <el-table-column label="琴号" width="100">
          <template #default="scope">
            <span v-if="scope.row.guqinNo">{{ scope.row.guqinNo }}</span>
            <el-tag v-else type="info" size="small">待配对</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="part" label="部位" width="80" />
        <el-table-column prop="species" label="树种" width="80" />
        <el-table-column prop="dryYears" label="阴干(年)" width="90" />
        <el-table-column prop="thicknessMm" label="厚度(mm)" width="90" />
        <el-table-column prop="grain" label="木纹" width="90" />
        <el-table-column prop="defect" label="缺陷" width="80" />
        <el-table-column label="入库" width="110">
          <template #default="scope">{{ formatDate(scope.row.receivedAt) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="120" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
            <el-button link type="danger" @click="remove(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <EmptyPanel
        v-if="visible.length === 0"
        description="没有符合条件的板材"
        action-text="重置筛选条件"
        @action="filter.reset()"
      />
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">
          <span>槽腹剖面标注（DimensionChart）</span>
          <el-select v-model="selectedGuqin" placeholder="选择琴号" clearable style="width: 160px">
            <el-option v-for="no in boardStore.guqinNos" :key="no" :label="no" :value="no" />
          </el-select>
        </div>
      </template>
      <DimensionChart v-if="chartMarks.length" :marks="chartMarks" :chamber-depth="chartDepth" :guqin-no="selectedGuqin" />
      <el-empty v-else :image-size="60" description="选择已有槽腹记录的琴号即可查看剖面标注" />
    </el-card>

    <!-- 登记 / 编辑板材 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑板材' : '登记板材'" width="620px">
      <el-alert
        v-if="editingBoard?.guqinNo"
        type="info"
        :closable="false"
        class="form-alert"
        :title="`该板材当前属于琴号 ${editingBoard.guqinNo}；琴号由配对/换板操作管理，如需换板请到配对表操作。`"
      />
      <el-alert
        v-else
        type="info"
        :closable="false"
        class="form-alert"
        title="登记后板材进入待配对池，琴号在「配对成一副」时指定，无需手填。"
      />
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="板材号" prop="boardNo">
          <el-input v-model="form.boardNo" placeholder="如：MB-2511" maxlength="20" />
        </el-form-item>
        <el-form-item label="部位">
          <el-select v-model="form.part" :disabled="Boolean(editingBoard?.guqinNo)" style="width: 160px">
            <el-option v-for="part in BOARD_PARTS" :key="part" :label="part" :value="part" />
          </el-select>
          <div v-if="editingBoard?.guqinNo" class="field-hint">已配对板材不能改部位，避免同一琴号出现同部位重复</div>
        </el-form-item>
        <el-form-item label="树种">
          <el-select v-model="form.species" style="width: 160px">
            <el-option v-for="species in WOOD_SPECIES" :key="species" :label="species" :value="species" />
          </el-select>
        </el-form-item>
        <el-form-item label="阴干年限(年)">
          <el-input-number v-model="form.dryYears" :min="0" :max="60" placeholder="阴干年限" />
        </el-form-item>
        <el-form-item label="厚度(mm)">
          <el-input-number v-model="form.thicknessMm" :min="5" :max="80" :step="0.5" placeholder="厚度" />
        </el-form-item>
        <el-form-item label="木纹">
          <el-select v-model="form.grain" style="width: 160px">
            <el-option v-for="grain in WOOD_GRAINS" :key="grain" :label="grain" :value="grain" />
          </el-select>
        </el-form-item>
        <el-form-item label="缺陷">
          <el-select v-model="form.defect" style="width: 160px">
            <el-option v-for="defect in WOOD_DEFECTS" :key="defect" :label="defect" :value="defect" />
          </el-select>
        </el-form-item>
        <el-form-item label="入库日期">
          <el-date-picker v-model="form.receivedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="60" placeholder="产地、纹理等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 配对成一副 -->
    <el-dialog v-model="pairVisible" title="配对成一副" width="560px">
      <el-form label-width="90px">
        <el-form-item label="面板">
          <el-select v-model="pairPanelId" filterable placeholder="从待配对面板中挑选" style="width: 100%">
            <el-option v-for="b in boardStore.pendingPanels" :key="b.id" :label="boardLabel(b)" :value="b.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="底板">
          <el-select v-model="pairBaseId" filterable placeholder="从待配对底板中挑选" style="width: 100%">
            <el-option v-for="b in boardStore.pendingBases" :key="b.id" :label="boardLabel(b)" :value="b.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="琴号">
          <el-select v-model="pairGuqinNo" filterable allow-create default-first-option placeholder="选择已有琴号或输入新琴号" style="width: 100%">
            <el-option v-for="no in guqinOptions" :key="no" :label="no" :value="no" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="pairBlocked"
        type="error"
        :closable="false"
        :title="`琴号 ${pairGuqinNo.trim()} 已占用，无法配对：${[
          pairOccupants.panel ? `面板已是 ${pairOccupants.panel.boardNo}` : '',
          pairOccupants.base ? `底板已是 ${pairOccupants.base.boardNo}` : '',
        ].filter(Boolean).join('；')}。同一部位不接受第二块板。`"
      />
      <el-alert
        v-else
        type="success"
        :closable="false"
        title="两块板材将共用此琴号，配对后不再属于待配对池。"
      />
      <template #footer>
        <el-button @click="pairVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!pairReady" @click="submitPair">确认配对</el-button>
      </template>
    </el-dialog>

    <!-- 补空缺 / 换板 -->
    <el-dialog v-model="assignVisible" :title="assignOccupant ? `更换${assignPart}` : `补入${assignPart}`" width="560px">
      <el-form label-width="90px">
        <el-form-item label="琴号">
          <span class="assign-no">{{ assignGuqinNo }}</span>
        </el-form-item>
        <el-form-item label="部位">
          <span>{{ assignPart }}</span>
        </el-form-item>
        <el-form-item :label="assignOccupant ? '新板材' : '板材'">
          <el-select v-model="assignBoardId" filterable placeholder="从待配对池中挑选" style="width: 100%">
            <el-option v-for="b in assignCandidates" :key="b.id" :label="boardLabel(b)" :value="b.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert v-if="assignBlockReasons.length" type="error" :closable="false" class="form-alert" title="该琴暂不能换板：">
        <ul class="reason-list">
          <li v-for="(reason, index) in assignBlockReasons" :key="index">{{ reason }}</li>
        </ul>
      </el-alert>
      <el-alert
        v-else-if="assignOccupant"
        type="warning"
        :closable="false"
        class="form-alert"
        :title="`新${assignPart}将接管琴号，原${assignPart} ${assignOccupant.boardNo} 自动退回待配对池。`"
      />
      <el-alert v-else type="success" :closable="false" class="form-alert" :title="`该部位尚空缺，选板补入后即与另一块凑成一副。`" />
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!assignReady" @click="submitAssign">
          {{ assignOccupant ? '确认换板' : '确认补入' }}
      </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-title {
  margin: 0 0 4px;
  font-size: 20px;
  color: #4a3728;
}
.page-desc {
  margin: 0 0 12px;
  color: #8a7a68;
  font-size: 13px;
}
.toolbar {
  margin-bottom: 12px;
}
.block {
  margin-bottom: 16px;
  border-radius: 8px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-note {
  font-size: 12px;
  color: #8a7a68;
}
.conflict-tag {
  margin: 2px 6px 2px 0;
}
.pool-title {
  margin: 4px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: #4a3728;
}
.form-alert {
  margin-bottom: 14px;
}
.reason-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
.assign-no {
  font-weight: 600;
  color: #4a3728;
}
.field-hint {
  font-size: 12px;
  color: #a3968a;
  line-height: 1.4;
}
</style>
