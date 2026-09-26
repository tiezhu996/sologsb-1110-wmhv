import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { BoardPair, WoodBoard } from '../types/wood-board';

/** 由阴干年限推算含水率（%）：阴干越久含水率越低，收敛到 5% 左右 */
export function moisturePctOf(dryYears: number): number {
  const years = Number(dryYears) || 0;
  const pct = 14.5 - years * 1.15;
  return Number(Math.min(14.5, Math.max(5, pct)).toFixed(1));
}

/** 是否为可用板材：无裂纹且阴干 ≥ 3 年 */
export function boardUsable(board: WoodBoard): boolean {
  return board.defect !== '裂纹' && board.dryYears >= 3;
}

/**
 * 面板与底板按琴号配对。
 * - 未填琴号（待配对）的板材不进入配对表，由待配对列表单独呈现；
 * - 同一琴号同一部位若有多块，只取第一块进入面板/底板槽位，
 *   其余收进 extraPanels / extraBases 明确标出冲突，不再悄悄挂在明细里。
 */
export function pairBoards(boards: WoodBoard[]): BoardPair[] {
  const map = new Map<string, BoardPair>();
  boards.forEach((board) => {
    if (!board.guqinNo?.trim()) return;
    const pair =
      map.get(board.guqinNo) ??
      {
        guqinNo: board.guqinNo,
        extraPanels: [],
        extraBases: [],
        species: '',
        moisturePct: 0,
        matched: false,
      };
    if (board.part === '面板') {
      if (pair.panel) {
        pair.extraPanels.push(board);
      } else {
        pair.panel = board;
        pair.species = board.species;
      }
    } else if (pair.base) {
      pair.extraBases.push(board);
    } else {
      pair.base = board;
      if (!pair.species) pair.species = board.species;
    }
    map.set(board.guqinNo, pair);
  });

  return Array.from(map.values())
    .map((pair) => {
      const matched = Boolean(pair.panel && pair.base);
      const years = Math.max(pair.panel?.dryYears ?? 0, pair.base?.dryYears ?? 0);
      return { ...pair, matched, moisturePct: moisturePctOf(years) };
    })
    .sort((a, b) => a.guqinNo.localeCompare(b.guqinNo));
}

/** 面板/底板厚度差（mm），差值过大需再刨削 */
export function thicknessGap(pair: BoardPair): number {
  if (!pair.panel || !pair.base) {
    return 0;
  }
  return Number(Math.abs(pair.panel.thicknessMm - pair.base.thicknessMm).toFixed(1));
}

/**
 * 换板前置校验：已经掏膛或已经髹漆的琴不允许换板。
 * 返回禁止原因列表；为空表示可以换。
 * 说明：掏过膛的面板槽腹尺寸已经成形，髹过漆的灰胎与板身连为一体，
 * 此时换板会使槽腹/髹漆记录与实物对不上，需先在对应工序页处理后再换。
 */
export function swapBlockReasons(guqinNo: string, chambers: SoundChamber[], layers: LacquerLayer[]): string[] {
  const reasons: string[] = [];
  if (chambers.some((c) => c.guqinNo === guqinNo)) {
    reasons.push('该琴已经掏膛（槽腹记录已成形），换板会导致槽腹尺寸与实物不符');
  }
  if (layers.some((l) => l.guqinNo === guqinNo)) {
    reasons.push('该琴已经髹漆（灰胎与板身连为一体），换板后髹漆遍次记录无法对应');
  }
  return reasons;
}
