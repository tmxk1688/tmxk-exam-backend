/**
 * 2026年天马行空创意团队AIGC+计算机网络+网站开发专项考核试卷
 * 第一部分 客观基础题型
 */

const OBJECTIVE_MAX = 40;
const PRACTICAL_MAX = 60;
const PRACTICAL_TASK1_MAX = 30;
const PRACTICAL_TASK2_MAX = 30;
const TOTAL_MAX = 100;

const EXAM_INFO = {
  title: '2026年天马行空创意团队AIGC专项考核',
  subtitle: 'AIGC+计算机网络+网站开发专项考核试卷',
  duration: 45,
  totalScore: TOTAL_MAX,
  positions: ['创意全岗', '新媒体运营', '视觉设计', '视频剪辑', 'AI技能师综合岗'],
  rules: [
    '考核时长45分钟，试卷满分100分（客观题40分 + 实操题60分）',
    '线上闭卷笔试+本地电脑实操上机结合，全程独立作答',
    '禁止联网违规抄录、禁止跨工位互助协同',
    '客观题在线作答，实操题完成后上传至云端归档文件夹'
  ]
};

const PRACTICAL_SECTION = {
  title: '第二部分 实操综合应用题（合计60分，云端文件夹归档）',
  uploadHint: '两个文件夹各上传 1 个文件后点击确认提交；提交后请等待考核结束，再通过成绩查询查看分数',
  materialLibrary: {
    title: '官方统一免费提供内置素材库',
    description: '请下载下方考生素材包，内含 LOGO、图标、背景等官方配套素材，供 PS 合成使用。',
    localPath: 'D:\\项目1\\考试系统\\考生素材包'
  },
  waitingHint: {
    title: '实操作品已提交，请等待考核结束',
    message: '您的两个文件已成功归档。请留在考场安静等待，待本次考核全部结束后，管理员将统一评分。',
    scoreQueryTip: '评分完成后，请返回首页点击「成绩查询」，凭准考证号与验证码查询客观题与实操总分。'
  },
  tasks: [
    {
      id: 1,
      folderKey: 'ai_materials',
      maxScore: PRACTICAL_TASK1_MAX,
      title: '实操第1题：AI创作中心API接口配置 + 指定主题海报主体素材AI生成（30分）',
      requirements: [
        '访问官方网址 tmxkcy.xyz，找到AI创作中心并核验功能入口',
        '完成361api.com API密钥配置（API URL: https://www.361api.com/v1/chat/completions）',
        '模型选型：对话用GPT-5.4 Nano；生图用Gemini 2.5 Flash Image Preview或Z-Image Turbo',
        '使用提示词智能助手，编写正向+反向提示词，锁定9:16科技商务简约风格',
        '调取官方内置素材库（考生素材包，系统免费提供下载）全部配套素材',
        'AI生成背景图上传至云端【考生号-AI素材专用文件夹】（本文件夹上传 1 个文件）'
      ]
    },
    {
      id: 2,
      folderKey: 'poster_works',
      maxScore: PRACTICAL_TASK2_MAX,
      title: '实操第2题：PS合成完整AI功能推广海报 + 规范分层归档成品（30分）',
      requirements: [
        '顶部放置天马行空创意团队官方LOGO，主标题：天马行空AI创作中心全新上线',
        '副标题：AI一键生成视频 · 高清海报图片 · 原创背景音乐 · 智能在线对话',
        '底部标注官方网址 tmxkcy.xyz，右下角标注：团队内部专属办公创作工具',
        'PS分层命名：背景层、AI主视觉层、LOGO层、标题文字层、功能图标层',
        '导出 JPG、PNG、PSD 三种格式合成成品，上传至云端【考生号-海报作品归档文件夹】（本文件夹上传 1 个文件）'
      ]
    }
  ]
};

const QUESTIONS = [
  {
    id: 1,
    type: 'single',
    score: 2,
    content: '下列工具中，不属于国内合规主流AIGC图片生成专用工具的是（  ）',
    options: [
      { key: 'A', text: '文心一格' },
      { key: 'B', text: '通义万相' },
      { key: 'C', text: 'Midjourney' },
      { key: 'D', text: '讯飞智绘' }
    ],
    answer: 'C'
  },
  {
    id: 2,
    type: 'single',
    score: 2,
    content: '天马行空创意网官方专属访问域名tmxkcy.xyz对应的网络归属属性是（  ）',
    options: [
      { key: 'A', text: '国家顶级域名' },
      { key: 'B', text: '新通用合规顶级域名' },
      { key: 'C', text: '加密专属内网域名' },
      { key: 'D', text: '商用专属二级域名' }
    ],
    answer: 'B'
  },
  {
    id: 3,
    type: 'single',
    score: 2,
    content: '短视频后期剪辑中，剪映专业版相较于PR，最适配团队批量快速出片的核心优势是（  ）',
    options: [
      { key: 'A', text: '无损高清多层级特效渲染' },
      { key: 'B', text: '轻量化免付费、内置AI智能字幕智能抠像、上手零门槛' },
      { key: 'C', text: '支持超长篇影视级轨道剪辑' },
      { key: 'D', text: '适配高端影视调色全套插件' }
    ],
    answer: 'B'
  },
  {
    id: 4,
    type: 'single',
    score: 2,
    content: '高质量AIGC视觉海报创作中，行业通用标准海报主流生成比例9:16精准适配的应用场景是（  ）',
    options: [
      { key: 'A', text: '线下大型户外展板海报' },
      { key: 'B', text: '朋友圈短视频封面、短视频账号主页海报、手机全屏信息流海报' },
      { key: 'C', text: '企业纸质宣传画册内页' },
      { key: 'D', text: '横版公众号首图配图' }
    ],
    answer: 'B'
  },
  {
    id: 5,
    type: 'single',
    score: 2,
    content: '企业办公局域网正常通信工作核心原理中，实现团队工位多台电脑互联互通、文件互传、内网协同办公的核心设备是（  ）',
    options: [
      { key: 'A', text: '高清摄像头' },
      { key: 'B', text: '交换机+路由器联动组网' },
      { key: 'C', text: '外接移动硬盘' },
      { key: 'D', text: '桌面音响设备' }
    ],
    answer: 'B'
  },
  {
    id: 6,
    type: 'single',
    score: 2,
    content: 'AIGC对话生成、素材批量调取全流程中，平台API接口配置的核心直接作用是（  ）',
    options: [
      { key: 'A', text: '美化网站前端页面排版样式' },
      { key: 'B', text: '打通本地电脑与云端AI大模型数据双向安全通信通道，合规调用算力资源' },
      { key: 'C', text: '提升电脑本机开机运行速度' },
      { key: 'D', text: '优化浏览器网页字体显示效果' }
    ],
    answer: 'B'
  },
  {
    id: 7,
    type: 'single',
    score: 2,
    content: '职场商务办公场景中，企业合规邮箱发送批量工作素材、考核文件时，必须规范规避的违规操作是（  ）',
    options: [
      { key: 'A', text: '规范添加邮件主题标注考生信息' },
      { key: 'B', text: '超大附件无加密、无脱敏直接外传团队内部涉密创意素材' },
      { key: 'C', text: '精准填写收件人内部工号邮箱' },
      { key: 'D', text: '正文标注素材使用考核用途' }
    ],
    answer: 'B'
  },
  {
    id: 8,
    type: 'single',
    score: 2,
    content: 'AI视频自动生成技术核心底层依托的核心技术架构是（  ）',
    options: [
      { key: 'A', text: '大语言多模态生成模型+算力集群并行推理' },
      { key: 'B', text: '单一本地图片压缩算法' },
      { key: 'C', text: '简易办公表格运算程序' },
      { key: 'D', text: '离线音频解码小程序' }
    ],
    answer: 'A'
  },
  {
    id: 9,
    type: 'single',
    score: 2,
    content: '天马行空创意网AI创作中心实操场景中，调用平台AI能力生成标准化创意素材前，必须优先完成的前置步骤是（  ）',
    options: [
      { key: 'A', text: '关闭电脑全部杀毒软件' },
      { key: 'B', text: '完成合规API密钥绑定配置、校验网络连通正常' },
      { key: 'C', text: '直接打开PS软件开始合成海报' },
      { key: 'D', text: '删除电脑本地全部办公文件' }
    ],
    answer: 'B'
  },
  {
    id: 10,
    type: 'single',
    score: 2,
    content: 'AI提示词高阶优化实操中，想要精准控制海报画面风格、色彩调性、构图细节、输出精度，核心关键操作是（  ）',
    options: [
      { key: 'A', text: '仅输入简短模糊需求话术' },
      { key: 'B', text: '分层撰写主体画面+风格调性+尺寸比例+画质参数+场景约束结构化精准提示词' },
      { key: 'C', text: '随意粘贴网络无关文案' },
      { key: 'D', text: '重复发送单一句式无差别指令' }
    ],
    answer: 'B'
  },
  {
    id: 11,
    type: 'single',
    score: 2,
    content: 'PS海报后期合成实操中，分层保存工程源文件、方便后续二次修改调整的专属格式是（  ）',
    options: [
      { key: 'A', text: 'JPG通用图片格式' },
      { key: 'B', text: 'PSD分层工程源文件格式' },
      { key: 'C', text: 'MP4视频格式' },
      { key: 'D', text: 'MP3音频格式' }
    ],
    answer: 'B'
  },
  {
    id: 12,
    type: 'single',
    score: 2,
    content: '下列属于国外主流合规AIGC音频、背景音乐自动生成工具的是（  ）',
    options: [
      { key: 'A', text: '剪映内置免费配乐库' },
      { key: 'B', text: 'Suno AI' },
      { key: 'C', text: '讯飞音乐智作平台' },
      { key: 'D', text: '网易云音乐本地曲库' }
    ],
    answer: 'B'
  },
  {
    id: 13,
    type: 'single',
    score: 2,
    content: 'AI赋能轻量化网站开发实操中，利用AI快速批量生成网页前端排版代码，核心大幅提升优化的工作环节是（  ）',
    options: [
      { key: 'A', text: '线下办公设备采购流程' },
      { key: 'B', text: '前端静态页面快速布局、样式优化、基础功能轻量化代码编写' },
      { key: 'C', text: '企业办公场地规划布局' },
      { key: 'D', text: '员工考勤排班统计核算' }
    ],
    answer: 'B'
  },
  {
    id: 14,
    type: 'single',
    score: 2,
    content: '局域网办公环境突发断网故障排查中，第一步优先快速核查的核心点位是（  ）',
    options: [
      { key: 'A', text: '电脑桌面壁纸是否正常显示' },
      { key: 'B', text: '交换机电源运行状态、工位网线端口插拔连通情况' },
      { key: 'C', text: '打印机耗材余量多少' },
      { key: 'D', text: '鼠标键盘是否灵敏可用' }
    ],
    answer: 'B'
  },
  {
    id: 15,
    type: 'single',
    score: 2,
    content: 'PR专业剪辑软件相较于剪映，专属适配专业影视级后期剪辑的核心功能优势是（  ）',
    options: [
      { key: 'A', text: '一键自动生成短视频爆款文案' },
      { key: 'B', text: '多层级高精度影视调色、专业轨道精细化剪辑、适配大型项目成片输出' },
      { key: 'C', text: '无需安装直接网页在线使用' },
      { key: 'D', text: '内置海量免费无版权全品类素材' }
    ],
    answer: 'B'
  },
  {
    id: 16,
    type: 'judge',
    score: 2,
    content: '天马行空创意网AI创作中心实操时，无需配置API接口，直接点击按钮即可无限免费调用全部AI生成算力资源。（  ）',
    answer: 'false'
  },
  {
    id: 17,
    type: 'judge',
    score: 2,
    content: '9:16竖版比例素材是短视频账号运营、手机端全屏创意海报的最优适配主流比例。（  ）',
    answer: 'true'
  },
  {
    id: 18,
    type: 'judge',
    score: 2,
    content: '企业内部办公局域网仅能实现电脑联网上网，无法完成工位之间创意素材高速互传、内网协同办公。（  ）',
    answer: 'false'
  },
  {
    id: 19,
    type: 'judge',
    score: 2,
    content: '精准优质AI提示词可以有效减少AI生成画面模糊、构图错乱、主体偏差、细节失真等劣质素材问题，提升成品合规可用度。（  ）',
    answer: 'true'
  },
  {
    id: 20,
    type: 'judge',
    score: 2,
    content: '本次考核实操产出的海报成品，仅保存JPG格式即可，无需留存PSD分层源文件归档备份。（  ）',
    answer: 'false'
  }
];

function getPublicQuestions() {
  return QUESTIONS.map(({ answer, ...q }) => q);
}

function getQuestionMap() {
  const map = {};
  for (const q of QUESTIONS) map[q.id] = q;
  return map;
}

function calculateScore(answers) {
  let score = 0;
  const details = [];

  for (const q of QUESTIONS) {
    const userAnswer = answers[String(q.id)];
    let correct = false;

    if (q.type === 'single') {
      correct = userAnswer === q.answer;
    } else if (q.type === 'judge') {
      correct = userAnswer === q.answer;
    }

    if (correct) score += q.score;

    details.push({
      questionId: q.id,
      userAnswer: userAnswer || null,
      correctAnswer: q.answer,
      correct,
      score: correct ? q.score : 0
    });
  }

  return { score, maxScore: 40, details };
}

function buildAnswerDetails(answers) {
  const { score, maxScore, details } = calculateScore(answers || {});
  const qMap = getQuestionMap();
  return {
    score,
    maxScore,
    details: details.map((d) => {
      const q = qMap[d.questionId];
      return {
        ...d,
        content: q?.content || '',
        type: q?.type || '',
        maxScore: q?.score || 0,
        options: q?.options || null
      };
    })
  };
}

module.exports = {
  EXAM_INFO,
  PRACTICAL_SECTION,
  QUESTIONS,
  OBJECTIVE_MAX,
  PRACTICAL_MAX,
  PRACTICAL_TASK1_MAX,
  PRACTICAL_TASK2_MAX,
  TOTAL_MAX,
  getPublicQuestions,
  calculateScore,
  buildAnswerDetails
};
