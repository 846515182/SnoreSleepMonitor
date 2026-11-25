/**
 * 单帧声音分类 —— 纯逻辑，App 与「整晚模拟」共用同一套规则。
 *
 * 以前这段散落在 App.tsx 的 applyNativeResult 里，模拟测试只能照着抄一份，
 * 抄错了也发现不了；现在收敛到这里，单元测试跑的就是线上那一套。
 */

import { describeYamnetClass } from './noiseLabels';

/** 鼾声的最低音量（dBFS）：太轻的声音不可能是一个人躺在手机旁边打鼾 */
export const SNORE_MIN_DB = -48;

/**
 * 翻身/床体噪声的最低音量：被褥摩擦、床架吱呀通常在 -55dB 以上。
 * 再低就只剩远处环境声，不能算翻身。
 */
export const TURN_MIN_DB = -55;

/**
 * 其他声音（环境噪音）的最低音量。
 * 低于 -52dB 基本是房间底噪（空调低频、窗外远路），收进来只会刷屏；
 * 咳嗽、喷嚏、说话、开关门、狗叫、电视等一旦到了这个音量，就逐条记录。
 */
export const NOISE_MIN_DB = -52;

/** YAMNet 异常呼吸音（喘息/喘鸣/喷气）置信度：只用于确认一次暂停结束 */
export const APNEA_SOUND_CONF = 0.45;

/** 默认阈值（设置页可调） */
export const DEFAULT_SNORE_CONFIDENCE = 0.55;
export const DEFAULT_GRIND_CONFIDENCE = 0.4;
export const DEFAULT_TALK_CONFIDENCE = 0.55;
/** 翻身/床体噪声阈值：不进设置页（属于记录性事件，过低会把空调摆风也收进来） */
export const DEFAULT_TURN_CONFIDENCE = 0.4;

export interface FrameInput {
  /** YAMNet 聚合后的 top 类别：snoring / grinding / talking / apnea / turn / noise */
  topClass: string;
  /** 各类别聚合置信度（0–1） */
  confidences: Record<string, number>;
  /** 本帧音量，dBFS（-100 表示几乎无声） */
  amplitudeDb: number;
  /** YAMNet 原始类别名（如 "Cough"），用于给噪音事件生成中文文字标签 */
  yamnetClass?: string;
}

export interface Thresholds {
  snore: number;
  grind: number;
  talk: number;
  /** 翻身/床体噪声阈值，默认 DEFAULT_TURN_CONFIDENCE */
  turn?: number;
  /**
   * 自适应音量下限（可选）。不传时使用固定常量，保持旧调用方与测试行为不变；
   * App 会按环境底噪动态传入，避免安静房间漏记、空调房误报。
   */
  snoreMinDb?: number;
  turnMinDb?: number;
  noiseMinDb?: number;
}

export interface FrameFlags {
  snore: boolean;
  grind: boolean;
  talk: boolean;
  /** 翻身 / 床体噪声帧 */
  turn: boolean;
  /** 其他可听声音（不属于上面四类），会被记录为环境噪音事件 */
  noise: boolean;
  /** 异常呼吸音（不代表一定是事件） */
  apneaSound: boolean;
  /** 任意可听声音帧：用于锚定静音起点、合并事件 */
  loud: boolean;
  /** 呼吸类声音：用于「收口」一次疑似暂停 */
  breath: boolean;
  /** 噪音帧识别到的具体声音中文标签（如「咳嗽声」） */
  soundLabel?: string;
}

/**
 * 判断一帧属于哪类声音。
 *
 * 三道鼾声门槛：本帧 top 是 snoring、置信度过阈值、音量不能太小。
 * 加音量门槛是因为远处的电视声/雨声偶尔也会被 YAMNet 判成 snoring，
 * 但它们到手机时已经很轻；真人打鼾（手机放床头）基本都在 -50dB 以上。
 */
export function classifyFrame(frame: FrameInput, t: Thresholds): FrameFlags {
  const sConf = frame.confidences.snoring ?? 0;
  const gConf = frame.confidences.grinding ?? 0;
  const tConf = frame.confidences.talking ?? 0;
  const aConf = frame.confidences.apnea ?? 0;
  const rConf = frame.confidences.turn ?? 0;
  const turnThreshold = t.turn ?? DEFAULT_TURN_CONFIDENCE;
  const snoreMinDb = t.snoreMinDb ?? SNORE_MIN_DB;
  const turnMinDb = t.turnMinDb ?? TURN_MIN_DB;
  const noiseMinDb = t.noiseMinDb ?? NOISE_MIN_DB;

  const snore =
    frame.topClass === 'snoring' && sConf >= t.snore && frame.amplitudeDb >= snoreMinDb;

  // 磨牙：置信度必须过用户阈值（此前这个阈值是死的），并且要压过鼾声/梦话；
  // 只有 high-confidence 或 top 类别明确是 grinding 才算，避免翻身、呼吸被算进来。
  const grind =
    gConf >= t.grind && (frame.topClass === 'grinding' || gConf >= 0.5) && gConf >= sConf && gConf >= tConf;

  // 梦话同样要求 top 类别是 talking，避免把电视/环境人声混进梦话统计。
  const talk = frame.topClass === 'talking' && tConf >= t.talk;

  /**
   * 翻身/床体噪声：床垫与床架的吱呀、被褥摩擦（rustle）、身体落床的闷响。
   *
   * 只在 top 类别就是 turn 时成立：这样它永远不会从鼾声/梦话/磨牙的帧里抢走事件，
   * 也避免"房间里刚好有点摩擦声"就把其他事件改判成翻身。音量下限挡掉远处环境声。
   */
  const turn =
    frame.topClass === 'turn' && rConf >= turnThreshold && frame.amplitudeDb >= turnMinDb;

  /**
   * 其他声音：既不是鼾声/磨牙/梦话/翻身，但确实有可听音量。
   * 这些声音以前会被直接丢掉；现在统一收进噪音事件，并用 YAMNet 原始类别
   * 生成「咳嗽声」「狗叫声」「开关门声」等中文标签，做到「所有声音都记录」。
   */
  const noise = !(snore || grind || talk || turn) && frame.amplitudeDb >= noiseMinDb;

  const loud = snore || grind || talk || turn || noise;
  // 原始类别标签对所有可听帧都保留：稳态风扇可能被误判成 snoring，
  // 事件兜底成噪音时仍能用「室内环境声」这类文字标注，而不是只能显示「环境噪音」。
  const soundLabel = loud ? describeYamnetClass(frame.yamnetClass) : undefined;
  const apneaSound = aConf >= APNEA_SOUND_CONF;

  return {
    snore,
    grind,
    talk,
    turn,
    noise,
    apneaSound,
    loud,
    breath: snore || apneaSound,
    ...(soundLabel ? { soundLabel } : {}),
  };
}
