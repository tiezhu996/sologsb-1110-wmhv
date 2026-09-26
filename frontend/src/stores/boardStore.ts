import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { pairBoards, boardUsable, swapBlockedReasons } from '../utils/wood';
import { useChamberStore } from './chamberStore';
import { useLacquerStore } from './lacquerStore';
import type { BoardPart, BoardPair, WoodBoard, WoodDefect, WoodGrain, WoodSpecies } from '../types/wood-board';

export interface BoardInput {
  boardNo: string;
  part: BoardPart;
  species: WoodSpecies;
  dryYears: number;
  thicknessMm: number;
  grain: WoodGrain;
  defect: WoodDefect;
  receivedAt?: string;
  remark?: string;
}

/** 配对冲突：目标琴号在该部位已有板材 */
export class PairConflictError extends Error {
  /** 占用该琴号同一部位的板材（冲突来源） */
  conflictBoard: WoodBoard;
  constructor(board: WoodBoard) {
    super(`琴号 ${board.guqinNo} 的${board.part}已经是板材 ${board.boardNo}，同一部位不能再配第二块`);
    this.name = 'PairConflictError';
    this.conflictBoard = board;
  }
}

/** 换板被工序阻断：已经掏膛或髹漆 */
export class SwapBlockedError extends Error {
  reasons: string[];
  constructor(guqinNo: string, reasons: string[]) {
    super(`琴号 ${guqinNo} 暂不能换板：${reasons.join('；')}`);
    this.name = 'SwapBlockedError';
    this.reasons = reasons;
  }
}

interface BoardState {
  boards: WoodBoard[];
  hydrated: boolean;
}

/** 板材与面板/底板配对 */
export const useBoardStore = defineStore('board', {
  state: (): BoardState => ({ boards: [], hydrated: false }),

  getters: {
    /** 面板与底板按琴号配对并回显含水率 */
    pairs(state): BoardPair[] {
      return pairBoards(state.boards);
    },
    /** 可用板材数（无裂纹且阴干达标） */
    usableCount(state): number {
      return state.boards.filter(boardUsable).length;
    },
    guqinNos(state): string[] {
      return Array.from(new Set(state.boards.map((b) => b.guqinNo).filter(Boolean))).sort();
    },
    /** 待配对：尚未占用琴号的板材 */
    pendingBoards(state): WoodBoard[] {
      return state.boards
        .filter((b) => !b.guqinNo)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.boardNo.localeCompare(b.boardNo));
    },
    pendingPanels(): WoodBoard[] {
      return this.pendingBoards.filter((b) => b.part === '面板');
    },
    pendingBases(): WoodBoard[] {
      return this.pendingBoards.filter((b) => b.part === '底板');
    },
    boardsOf(state) {
      return (guqinNo: string): WoodBoard[] => state.boards.filter((b) => b.guqinNo === guqinNo);
    },
  },

  actions: {
    async hydrate() {
      this.boards = await db.boards.orderBy('boardNo').toArray();
      this.hydrated = true;
    },

    /** 登记板材：新板一律进入待配对池，琴号由后续配对步骤指定 */
    async addBoard(input: BoardInput): Promise<WoodBoard> {
      const board: WoodBoard = {
        id: uid('board'),
        boardNo: input.boardNo.trim(),
        guqinNo: '',
        part: input.part,
        species: input.species,
        dryYears: Number(input.dryYears) || 0,
        thicknessMm: Number(input.thicknessMm) || 0,
        grain: input.grain,
        defect: input.defect,
        receivedAt: input.receivedAt ?? new Date().toISOString(),
        remark: input.remark?.trim() || undefined,
      };
      await db.boards.put(toPlain(board));
      this.boards = [board, ...this.boards];
      return board;
    },

    async updateBoard(id: string, patch: Partial<BoardInput>) {
      const current = this.boards.find((b) => b.id === id);
      if (!current) return;
      const next: WoodBoard = { ...current, ...patch };
      await db.boards.put(toPlain(next));
      this.boards = this.boards.map((b) => (b.id === id ? next : b));
    },

    async removeBoard(id: string) {
      await db.boards.delete(id);
      this.boards = this.boards.filter((b) => b.id !== id);
    },

    /** 换板阻断原因（空数组表示允许换板）：已经掏膛或已经髹漆的琴先不让换 */
    blockSwapReasons(guqinNo: string): string[] {
      const chamberStore = useChamberStore();
      const lacquerStore = useLacquerStore();
      return swapBlockedReasons(Boolean(chamberStore.byGuqin(guqinNo)), lacquerStore.layersOf(guqinNo).length > 0);
    },

    /**
     * 配对成一副：一块面板 + 一块底板共用同一琴号。
     * 同一琴号的同一部位已有板材时拒绝，并由 PairConflictError 指出是哪块冲突。
     */
    async createPair(panelId: string, baseId: string, guqinNo: string) {
      const no = guqinNo.trim();
      const panel = this.boards.find((b) => b.id === panelId);
      const base = this.boards.find((b) => b.id === baseId);
      if (!panel || !base) throw new Error('所选板材不存在或已被删除');
      if (panel.part !== '面板' || base.part !== '底板') throw new Error('必须挑选一块面板和一块底板');
      if (!no) throw new Error('请填写琴号');
      if (panel.guqinNo || base.guqinNo) throw new Error('所选板材已在某副琴中，不能重复配对');

      const occupied = this.boards.find((b) => b.guqinNo === no && (b.part === '面板' || b.part === '底板'));
      if (occupied) throw new PairConflictError(occupied);

      const updated = [panel, base].map((b) => ({ ...b, guqinNo: no }));
      await db.transaction('rw', db.boards, async () => {
        for (const board of updated) await db.boards.put(toPlain(board));
      });
      this.boards = this.boards.map((b) => updated.find((u) => u.id === b.id) ?? b);
    },

    /**
     * 把一块待配对板材安排到某琴号的对应部位（补空缺 / 换板共用入口）。
     * - 该部位空缺：直接补入，凑成一副；
     * - 该部位已有板材（换板）：新板接管琴号，旧板清空琴号退回待配对；
     *   若琴已经掏膛或髹漆，则抛 SwapBlockedError 并说明原因。
     */
    async assignBoard(boardId: string, guqinNo: string) {
      const no = guqinNo.trim();
      const board = this.boards.find((b) => b.id === boardId);
      if (!board) throw new Error('所选板材不存在或已被删除');
      if (!no) throw new Error('请填写琴号');
      if (board.guqinNo === no) return;
      if (board.guqinNo) throw new Error('该板材已在某副琴中，不能重复配对');

      const occupant = this.boards.find((b) => b.guqinNo === no && b.part === board.part);
      let released: WoodBoard | undefined;
      if (occupant) {
        const reasons = this.blockSwapReasons(no);
        if (reasons.length) throw new SwapBlockedError(no, reasons);
        released = { ...occupant, guqinNo: '' };
      }

      const assigned = { ...board, guqinNo: no };
      const changed = released ? [assigned, released] : [assigned];
      await db.transaction('rw', db.boards, async () => {
        for (const item of changed) await db.boards.put(toPlain(item));
      });
      this.boards = this.boards.map((b) => changed.find((c) => c.id === b.id) ?? b);
      return { assigned, released };
    },

    /** 把一块板材（如配对表中的重复冲突板材）退回待配对池 */
    async releaseToPending(boardId: string) {
      const board = this.boards.find((b) => b.id === boardId);
      if (!board || !board.guqinNo) return;
      const released = { ...board, guqinNo: '' };
      await db.boards.put(toPlain(released));
      this.boards = this.boards.map((b) => (b.id === boardId ? released : b));
    },
  },
});
