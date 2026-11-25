/**
 * 把 YAMNet 的英文类别名翻译成界面上能直接看懂的短中文标签。
 *
 * 需求是「所有声音都记录，并用文字标出来」：YAMNet 本身有 521 个 AudioSet 类别，
 * 这里不追求把 521 个都翻一遍，而是把睡眠场景里常见的咳嗽、喷嚏、说话、狗叫、
 * 开关门、家电、交通、风雨等覆盖到；未命中的类别由界面统一显示为「环境噪音」。
 *
 * 匹配顺序很重要：越具体的规则越靠前（「car alarm」必须命中警报而不是交通，
 * 「baby cry」必须命中婴儿哭声而不是泛化的哭声）。
 */

interface LabelRule {
  /** 需要命中的 YAMNet 类别名（小写、按整词匹配，避免 rain 命中 train、car 命中 carnatic） */
  needles: readonly string[];
  label: string;
}

const RULES: readonly LabelRule[] = [
  { needles: ['snoring'], label: '打鼾声' },
  { needles: ['cough', 'coughing'], label: '咳嗽声' },
  { needles: ['throat clearing'], label: '清嗓子' },
  { needles: ['sneeze', 'sneezing'], label: '喷嚏声' },
  { needles: ['sniff', 'sniffling'], label: '吸鼻声' },
  { needles: ['wheeze', 'wheezing'], label: '喘息声' },
  { needles: ['gasp', 'gasping'], label: '急促呼吸声' },
  { needles: ['pant', 'panting'], label: '喘息声' },
  { needles: ['snort'], label: '哼鼻声' },
  { needles: ['breathing'], label: '呼吸声' },
  { needles: ['baby cry', 'infant cry'], label: '婴儿哭声' },
  { needles: ['crying', 'sobbing'], label: '哭声' },
  { needles: ['whimper'], label: '抽泣声' },
  { needles: ['wail', 'moan'], label: '呻吟声' },
  { needles: ['sigh'], label: '叹气声' },
  { needles: ['groan'], label: '呻吟声' },
  { needles: ['grunt'], label: '哼声' },
  { needles: ['laughter', 'laugh', 'giggle', 'snicker', 'chuckle', 'chortle'], label: '笑声' },
  { needles: ['shout', 'scream', 'yell', 'bellow', 'whoop'], label: '喊叫声' },
  {
    needles: ['speech', 'conversation', 'narration', 'monologue', 'babbling', 'whispering'],
    label: '说话声',
  },
  { needles: ['hubbub', 'chatter', 'crowd', 'children shouting', 'children playing'], label: '人声嘈杂' },
  { needles: ['singing', 'choir', 'yodeling', 'chant', 'mantra', 'rapping', 'humming'], label: '歌声' },
  { needles: ['applause', 'clapping', 'cheering'], label: '掌声' },
  { needles: ['burping', 'eructation', 'hiccup'], label: '打嗝声' },
  { needles: ['fart'], label: '肠胃排气声' },
  { needles: ['stomach rumble'], label: '肠胃声' },
  { needles: ['chewing', 'mastication'], label: '咀嚼声' },
  { needles: ['biting'], label: '咬合声' },
  { needles: ['gargling'], label: '漱口声' },
  { needles: ['dog', 'bark', 'howl', 'bow-wow', 'growling', 'yip'], label: '狗叫声' },
  { needles: ['cat', 'meow', 'purr', 'caterwaul'], label: '猫叫声' },
  { needles: ['hiss'], label: '嘶嘶声' },
  { needles: ['bird', 'chirp', 'tweet', 'squawk', 'coo', 'caw', 'hoot'], label: '鸟叫声' },
  { needles: ['insect', 'cricket', 'mosquito', 'buzz', 'bee', 'wasp'], label: '虫鸣声' },
  { needles: ['frog', 'croak'], label: '蛙鸣声' },
  {
    needles: [
      'music',
      'musical instrument',
      'piano',
      'guitar',
      'banjo',
      'sitar',
      'mandolin',
      'ukulele',
      'drum',
      'cymbal',
      'violin',
      'cello',
      'bass',
      'trumpet',
      'trombone',
      'saxophone',
      'clarinet',
      'flute',
      'harmonica',
      'accordion',
      'wood block',
      'singing',
      'song',
    ],
    label: '音乐声',
  },
  { needles: ['television'], label: '电视声' },
  { needles: ['radio'], label: '广播声' },
  { needles: ['alarm clock'], label: '闹钟声' },
  { needles: ['smoke detector', 'fire alarm', 'car alarm'], label: '警报声' },
  { needles: ['siren', 'buzzer', 'emergency vehicle', 'police car', 'ambulance', 'fire engine'], label: '警笛声' },
  { needles: ['doorbell', 'ding-dong'], label: '门铃声' },
  { needles: ['telephone', 'ringtone', 'busy signal', 'dial tone', 'dtmf'], label: '电话铃声' },
  { needles: ['knock', 'knocking'], label: '敲击声' },
  { needles: ['door', 'sliding door', 'slam', 'cupboard', 'drawer'], label: '开关门声' },
  { needles: ['typing', 'typewriter', 'computer keyboard'], label: '键盘声' },
  { needles: ['vacuum cleaner', 'hair dryer', 'blender', 'microwave', 'electric shaver', 'printer'], label: '家电声' },
  { needles: ['mechanical fan', 'air conditioning', 'fan'], label: '风扇/空调声' },
  { needles: ['vehicle horn', 'car horn', 'air horn', 'honking'], label: '汽车喇叭声' },
  { needles: ['vehicle', 'car', 'truck', 'bus', 'motorcycle', 'traffic', 'roadway'], label: '交通声' },
  { needles: ['train', 'subway', 'metro', 'rail', 'railroad'], label: '列车声' },
  { needles: ['aircraft', 'airplane', 'jet engine', 'helicopter', 'propeller'], label: '飞机声' },
  { needles: ['engine', 'idling', 'accelerating', 'revving', 'skidding', 'tire squeal'], label: '引擎/行驶声' },
  { needles: ['thunderstorm', 'thunder'], label: '雷声' },
  { needles: ['rain', 'raindrop'], label: '雨声' },
  {
    needles: ['water', 'stream', 'waterfall', 'ocean', 'waves', 'drip', 'pour', 'splash', 'trickle', 'gush', 'boiling'],
    label: '水声',
  },
  { needles: ['toilet flush'], label: '冲水声' },
  { needles: ['water tap', 'faucet', 'sink', 'bathtub'], label: '水龙头声' },
  { needles: ['wind', 'rustling leaves'], label: '风声' },
  { needles: ['fire', 'crackle'], label: '火/噼啪声' },
  { needles: ['dishes', 'cutlery', 'silverware', 'chopping', 'frying'], label: '餐具/烹饪声' },
  { needles: ['glass', 'shatter', 'chink', 'clink'], label: '玻璃/碰撞声' },
  {
    needles: ['smash', 'crash', 'breaking', 'bang', 'slap', 'smack', 'whack', 'thwack', 'thump', 'thud', 'thunk', 'boom'],
    label: '撞击/闷响声',
  },
  { needles: ['squeak', 'creak', 'wood', 'crack', 'clang'], label: '吱呀/木质声' },
  { needles: ['rustle', 'scratch', 'scrape', 'rub', 'crinkling', 'crumpling', 'tearing'], label: '摩擦声' },
  { needles: ['footsteps', 'walk', 'run', 'shuffle'], label: '脚步声' },
  { needles: ['clock', 'tick', 'tick-tock'], label: '钟表声' },
  { needles: ['keys jangling', 'coin'], label: '钥匙/硬币声' },
  { needles: ['zipper'], label: '拉链声' },
  { needles: ['inside, small room', 'inside, large room', 'inside, public space', 'reverberation', 'echo'], label: '室内环境声' },
  { needles: ['outside, urban', 'outside, rural'], label: '室外环境声' },
  {
    needles: ['white noise', 'pink noise', 'environmental noise', 'noise', 'static', 'mains hum', 'hum', 'rumble', 'cacophony'],
    label: '环境底噪',
  },
  { needles: ['silence'], label: '安静' },
  { needles: ['field recording'], label: '环境录音' },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MATCHERS = RULES.map((rule) => ({
  label: rule.label,
  patterns: rule.needles.map((needle) => new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i')),
}));

/**
 * @param rawClassName YAMNet 原始类别名（如 "Cough" / "Inside, small room"）
 * @returns 中文短标签；无法识别时返回 undefined（界面回退为「环境噪音」）
 */
export function describeYamnetClass(rawClassName?: string | null): string | undefined {
  const raw = (rawClassName ?? '').trim();
  if (!raw) return undefined;
  for (const matcher of MATCHERS) {
    if (matcher.patterns.some((pattern) => pattern.test(raw))) return matcher.label;
  }
  return undefined;
}
