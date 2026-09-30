// DiffSinger 声库目录（自动生成，请勿手工编辑）
// 来源：ModelScope aihobbyist/ACG-DiffSinger-VoiceDB @ master
// 生成方式：node scripts/diffsinger-ms/sync.mjs
// 生成时间：2026-09-30T10:48:41.305Z
//
// 说明：
//   - 本文件是「模型管理 → DiffSinger」板块的唯一数据源，保证清单完整、不遗漏、不截断。
//   - 每个条目的 url 均为直连 ModelScope 官方地址，全球同源，不做镜像替换。
//   - placeholder=true 表示上游仅放了占位文件、尚无真实权重，UI 中标注为暂不可用。
//   - 上游仓库更新后，重新运行同步脚本即可刷新本文件。

const MS_REPO = {
  "owner": "aihobbyist",
  "name": "ACG-DiffSinger-VoiceDB",
  "revision": "master"
};

/** 直连 ModelScope 官方下载地址（全球同源） */
function msFileUrl(repoPath) {
  return `https://www.modelscope.cn/api/v1/models/${MS_REPO.owner}/${MS_REPO.name}/repo` +
    `?Revision=${MS_REPO.revision}&FilePath=${encodeURIComponent(repoPath)}`;
}

/** 目录结构：作品 → 分类 → 模型（共 171 条，其中可用 163 条、占位 8 条） */
const WORKS = [
 {
  "id": "starrail",
  "label": "崩坏：星穹铁道",
  "source": "星穹铁道",
  "categories": [
   {
    "source": "第二部分",
    "label": "第二部分",
    "desc": "星穹铁道声库（第二部分）",
    "models": [
     {
      "name": "黑天鹅",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/黑天鹅.zip",
      "size": 413523987,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E9%BB%91%E5%A4%A9%E9%B9%85.zip"
     },
     {
      "name": "虎克",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/虎克.zip",
      "size": 413522958,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E8%99%8E%E5%85%8B.zip"
     },
     {
      "name": "花火",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/花火.zip",
      "size": 413328353,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E8%8A%B1%E7%81%AB.zip"
     },
     {
      "name": "黄泉",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/黄泉.zip",
      "size": 413167075,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E9%BB%84%E6%B3%89.zip"
     },
     {
      "name": "藿藿",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "双声线，包含藿藿和尾巴",
      "path": "星穹铁道/第二部分/藿藿.zip",
      "size": 413440545,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E8%97%BF%E8%97%BF.zip"
     },
     {
      "name": "姬子",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/姬子.zip",
      "size": 413097359,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E5%A7%AC%E5%AD%90.zip"
     },
     {
      "name": "加拉赫",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/加拉赫.zip",
      "size": 413222253,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E5%8A%A0%E6%8B%89%E8%B5%AB.zip"
     },
     {
      "name": "椒丘",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/椒丘.zip",
      "size": 413405849,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E6%A4%92%E4%B8%98.zip"
     },
     {
      "name": "杰帕德",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/杰帕德.zip",
      "size": 413751582,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E6%9D%B0%E5%B8%95%E5%BE%B7.zip"
     },
     {
      "name": "景元",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/景元.zip",
      "size": 413277221,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E6%99%AF%E5%85%83.zip"
     },
     {
      "name": "镜流",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/镜流.zip",
      "size": 413354483,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E9%95%9C%E6%B5%81.zip"
     },
     {
      "name": "卡芙卡",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/卡芙卡.zip",
      "size": 412769817,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E5%8D%A1%E8%8A%99%E5%8D%A1.zip"
     },
     {
      "name": "开拓者(男)",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/开拓者(男).zip",
      "size": 413023675,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E5%BC%80%E6%8B%93%E8%80%85(%E7%94%B7).zip"
     },
     {
      "name": "开拓者(女)",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/开拓者(女).zip",
      "size": 412921308,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E5%BC%80%E6%8B%93%E8%80%85(%E5%A5%B3).zip"
     },
     {
      "name": "克拉拉",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/克拉拉.zip",
      "size": 412762208,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E5%85%8B%E6%8B%89%E6%8B%89.zip"
     },
     {
      "name": "刻律德菈",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/刻律德菈.zip",
      "size": 413335763,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E5%88%BB%E5%BE%8B%E5%BE%B7%E8%8F%88.zip"
     },
     {
      "name": "灵砂",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第二部分",
      "desc": "第二部分声库",
      "path": "星穹铁道/第二部分/灵砂.zip",
      "size": 413601675,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%2F%E7%81%B5%E7%A0%82.zip"
     }
    ]
   },
   {
    "source": "第三部分",
    "label": "第三部分",
    "desc": "星穹铁道声库（第三部分）",
    "models": [
     {
      "name": "流萤",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/流萤.zip",
      "size": 413113136,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E6%B5%81%E8%90%A4.zip"
     },
     {
      "name": "卢卡",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/卢卡.zip",
      "size": 413174515,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E5%8D%A2%E5%8D%A1.zip"
     },
     {
      "name": "乱破",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/乱破.zip",
      "size": 413785236,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E4%B9%B1%E7%A0%B4.zip"
     },
     {
      "name": "罗刹",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/罗刹.zip",
      "size": 413135331,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E7%BD%97%E5%88%B9.zip"
     },
     {
      "name": "米沙",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/米沙.zip",
      "size": 413181172,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E7%B1%B3%E6%B2%99.zip"
     },
     {
      "name": "貊泽",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/貊泽.zip",
      "size": 413446420,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E8%B2%8A%E6%B3%BD.zip"
     },
     {
      "name": "那刻夏",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/那刻夏.zip",
      "size": 412957366,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E9%82%A3%E5%88%BB%E5%A4%8F.zip"
     },
     {
      "name": "娜塔莎",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/娜塔莎.zip",
      "size": 413070481,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E5%A8%9C%E5%A1%94%E8%8E%8E.zip"
     },
     {
      "name": "佩拉",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/佩拉.zip",
      "size": 413064938,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E4%BD%A9%E6%8B%89.zip"
     },
     {
      "name": "青雀",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/青雀.zip",
      "size": 413645350,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E9%9D%92%E9%9B%80.zip"
     },
     {
      "name": "刃",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/刃.zip",
      "size": 413319789,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E5%88%83.zip"
     },
     {
      "name": "阮•梅",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/阮•梅.zip",
      "size": 413500509,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E9%98%AE%E2%80%A2%E6%A2%85.zip"
     },
     {
      "name": "赛飞儿",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/赛飞儿.zip",
      "size": 413127221,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E8%B5%9B%E9%A3%9E%E5%84%BF.zip"
     },
     {
      "name": "三月七",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/三月七.zip",
      "size": 413239006,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E4%B8%89%E6%9C%88%E4%B8%83.zip"
     },
     {
      "name": "桑博",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/桑博.zip",
      "size": 413401153,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E6%A1%91%E5%8D%9A.zip"
     },
     {
      "name": "砂金",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/砂金.zip",
      "size": 412900436,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E7%A0%82%E9%87%91.zip"
     },
     {
      "name": "素裳",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/素裳.zip",
      "size": 413073154,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E7%B4%A0%E8%A3%B3.zip"
     },
     {
      "name": "缇宝",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第三部分",
      "desc": "第三部分声库",
      "path": "星穹铁道/第三部分/缇宝.zip",
      "size": 413042919,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%89%E9%83%A8%E5%88%86%2F%E7%BC%87%E5%AE%9D.zip"
     }
    ]
   },
   {
    "source": "第四部分",
    "label": "第四部分",
    "desc": "星穹铁道声库（第四部分）",
    "models": [
     {
      "name": "玲可",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/玲可.zip",
      "size": 412952302,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E7%8E%B2%E5%8F%AF.zip"
     },
     {
      "name": "停云",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/停云.zip",
      "size": 413239338,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E5%81%9C%E4%BA%91.zip"
     },
     {
      "name": "托帕&账账",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/托帕&账账.zip",
      "size": 412981564,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E6%89%98%E5%B8%95%26%E8%B4%A6%E8%B4%A6.zip"
     },
     {
      "name": "瓦尔特",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/瓦尔特.zip",
      "size": 412966891,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E7%93%A6%E5%B0%94%E7%89%B9.zip"
     },
     {
      "name": "万敌",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/万敌.zip",
      "size": 413270738,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E4%B8%87%E6%95%8C.zip"
     },
     {
      "name": "忘归人",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/忘归人.zip",
      "size": 413349691,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E5%BF%98%E5%BD%92%E4%BA%BA.zip"
     },
     {
      "name": "希儿",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/希儿.zip",
      "size": 413378181,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E5%B8%8C%E5%84%BF.zip"
     },
     {
      "name": "希露瓦",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/希露瓦.zip",
      "size": 413542392,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E5%B8%8C%E9%9C%B2%E7%93%A6.zip"
     },
     {
      "name": "遐蝶",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/遐蝶.zip",
      "size": 412972481,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E9%81%90%E8%9D%B6.zip"
     },
     {
      "name": "星期日",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/星期日.zip",
      "size": 413763750,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E6%98%9F%E6%9C%9F%E6%97%A5.zip"
     },
     {
      "name": "雪衣",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/雪衣.zip",
      "size": 417260439,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E9%9B%AA%E8%A1%A3.zip"
     },
     {
      "name": "彦卿",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/彦卿.zip",
      "size": 413343151,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E5%BD%A6%E5%8D%BF.zip"
     },
     {
      "name": "银狼",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/银狼.zip",
      "size": 413055529,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E9%93%B6%E7%8B%BC.zip"
     },
     {
      "name": "银枝",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/银枝.zip",
      "size": 412911192,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E9%93%B6%E6%9E%9D.zip"
     },
     {
      "name": "驭空",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/驭空.zip",
      "size": 413228529,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E9%A9%AD%E7%A9%BA.zip"
     },
     {
      "name": "云璃",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/云璃.zip",
      "size": 413328821,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E4%BA%91%E7%92%83.zip"
     },
     {
      "name": "真理医生",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/真理医生.zip",
      "size": 412853006,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E7%9C%9F%E7%90%86%E5%8C%BB%E7%94%9F.zip"
     },
     {
      "name": "知更鸟",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第四部分",
      "desc": "第四部分声库",
      "path": "星穹铁道/第四部分/知更鸟.zip",
      "size": 414068647,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E5%9B%9B%E9%83%A8%E5%88%86%2F%E7%9F%A5%E6%9B%B4%E9%B8%9F.zip"
     }
    ]
   },
   {
    "source": "第五部分",
    "label": "第五部分",
    "desc": "星穹铁道声库（第五部分）",
    "models": [
     {
      "name": "可可利亚",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第五部分",
      "desc": "第五部分声库",
      "path": "星穹铁道/第五部分/可可利亚.zip",
      "size": 10539656,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%94%E9%83%A8%E5%88%86%2F%E5%8F%AF%E5%8F%AF%E5%88%A9%E4%BA%9A.zip"
     },
     {
      "name": "帕姆",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第五部分",
      "desc": "第五部分声库",
      "path": "星穹铁道/第五部分/帕姆.zip",
      "size": 10443525,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%94%E9%83%A8%E5%88%86%2F%E5%B8%95%E5%A7%86.zip"
     },
     {
      "name": "昔涟",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第五部分",
      "desc": "第五部分声库",
      "path": "星穹铁道/第五部分/昔涟.zip",
      "size": 9990752,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%BA%94%E9%83%A8%E5%88%86%2F%E6%98%94%E6%B6%9F.zip"
     }
    ]
   },
   {
    "source": "第一部分",
    "label": "第一部分",
    "desc": "星穹铁道声库（第一部分）",
    "models": [
     {
      "name": "阿格莱雅",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/阿格莱雅.zip",
      "size": 413089975,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E9%98%BF%E6%A0%BC%E8%8E%B1%E9%9B%85.zip"
     },
     {
      "name": "阿兰",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/阿兰.zip",
      "size": 412784779,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E9%98%BF%E5%85%B0.zip"
     },
     {
      "name": "艾丝妲",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/艾丝妲.zip",
      "size": 412839502,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E8%89%BE%E4%B8%9D%E5%A6%B2.zip"
     },
     {
      "name": "白厄",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/白厄.zip",
      "size": 416229832,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E7%99%BD%E5%8E%84.zip"
     },
     {
      "name": "白露",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/白露.zip",
      "size": 413389129,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E7%99%BD%E9%9C%B2.zip"
     },
     {
      "name": "波提欧",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/波提欧.zip",
      "size": 413269747,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E6%B3%A2%E6%8F%90%E6%AC%A7.zip"
     },
     {
      "name": "布洛妮娅",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/布洛妮娅.zip",
      "size": 413523622,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E5%B8%83%E6%B4%9B%E5%A6%AE%E5%A8%85.zip"
     },
     {
      "name": "大黑塔",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/大黑塔.zip",
      "size": 412999481,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E5%A4%A7%E9%BB%91%E5%A1%94.zip"
     },
     {
      "name": "丹恒",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/丹恒.zip",
      "size": 413024445,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E4%B8%B9%E6%81%92.zip"
     },
     {
      "name": "飞霄",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/飞霄.zip",
      "size": 414997026,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E9%A3%9E%E9%9C%84.zip"
     },
     {
      "name": "翡翠",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/翡翠.zip",
      "size": 413060049,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E7%BF%A1%E7%BF%A0.zip"
     },
     {
      "name": "风堇",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/风堇.zip",
      "size": 413534423,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E9%A3%8E%E5%A0%87.zip"
     },
     {
      "name": "符玄",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/符玄.zip",
      "size": 412954131,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E7%AC%A6%E7%8E%84.zip"
     },
     {
      "name": "桂乃芬",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/桂乃芬.zip",
      "size": 413141477,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E6%A1%82%E4%B9%83%E8%8A%AC.zip"
     },
     {
      "name": "海瑟音",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/海瑟音.zip",
      "size": 413400772,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E6%B5%B7%E7%91%9F%E9%9F%B3.zip"
     },
     {
      "name": "寒鸦",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/寒鸦.zip",
      "size": 413026232,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E5%AF%92%E9%B8%A6.zip"
     },
     {
      "name": "黑塔",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/黑塔.zip",
      "size": 413063421,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2F%E9%BB%91%E5%A1%94.zip"
     },
     {
      "name": "Saber",
      "work": "崩坏：星穹铁道",
      "workId": "starrail",
      "category": "第一部分",
      "desc": "第一部分声库",
      "path": "星穹铁道/第一部分/Saber.zip",
      "size": 412896714,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93%2F%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%2FSaber.zip"
     }
    ]
   }
  ]
 },
 {
  "id": "genshin",
  "label": "原神",
  "source": "原神",
  "categories": [
   {
    "source": "稻妻城",
    "label": "稻妻城",
    "desc": "稻妻地区角色声库",
    "models": [
     {
      "name": "八重神子",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/八重神子.zip",
      "size": 413164057,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E5%85%AB%E9%87%8D%E7%A5%9E%E5%AD%90.zip"
     },
     {
      "name": "枫原万叶",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/枫原万叶.zip",
      "size": 413079741,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E6%9E%AB%E5%8E%9F%E4%B8%87%E5%8F%B6.zip"
     },
     {
      "name": "荒泷一斗",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/荒泷一斗.zip",
      "size": 413113670,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E8%8D%92%E6%B3%B7%E4%B8%80%E6%96%97.zip"
     },
     {
      "name": "九条裟罗",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/九条裟罗.zip",
      "size": 413076287,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E4%B9%9D%E6%9D%A1%E8%A3%9F%E7%BD%97.zip"
     },
     {
      "name": "久岐忍",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/久岐忍.zip",
      "size": 412903401,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E4%B9%85%E5%B2%90%E5%BF%8D.zip"
     },
     {
      "name": "雷电将军",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/雷电将军.zip",
      "size": 413212644,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E9%9B%B7%E7%94%B5%E5%B0%86%E5%86%9B.zip"
     },
     {
      "name": "鹿野院平藏",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/鹿野院平藏.zip",
      "size": 413033268,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E9%B9%BF%E9%87%8E%E9%99%A2%E5%B9%B3%E8%97%8F.zip"
     },
     {
      "name": "梦见月瑞希",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/梦见月瑞希.zip",
      "size": 412897357,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E6%A2%A6%E8%A7%81%E6%9C%88%E7%91%9E%E5%B8%8C.zip"
     },
     {
      "name": "绮良良",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/绮良良.zip",
      "size": 413060238,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E7%BB%AE%E8%89%AF%E8%89%AF.zip"
     },
     {
      "name": "珊瑚宫心海",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/珊瑚宫心海.zip",
      "size": 413203345,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E7%8F%8A%E7%91%9A%E5%AE%AB%E5%BF%83%E6%B5%B7.zip"
     },
     {
      "name": "神里绫华",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/神里绫华.zip",
      "size": 412887115,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E7%A5%9E%E9%87%8C%E7%BB%AB%E5%8D%8E.zip"
     },
     {
      "name": "神里绫人",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/神里绫人.zip",
      "size": 413133833,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E7%A5%9E%E9%87%8C%E7%BB%AB%E4%BA%BA.zip"
     },
     {
      "name": "托马",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/托马.zip",
      "size": 413056706,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E6%89%98%E9%A9%AC.zip"
     },
     {
      "name": "五郎",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/五郎.zip",
      "size": 413058199,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E4%BA%94%E9%83%8E.zip"
     },
     {
      "name": "宵宫",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/宵宫.zip",
      "size": 413026485,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E5%AE%B5%E5%AE%AB.zip"
     },
     {
      "name": "早柚",
      "work": "原神",
      "workId": "genshin",
      "category": "稻妻城",
      "desc": "稻妻城声库",
      "path": "原神/稻妻城/早柚.zip",
      "size": 413028220,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%A8%BB%E5%A6%BB%E5%9F%8E%2F%E6%97%A9%E6%9F%9A.zip"
     }
    ]
   },
   {
    "source": "枫丹廷",
    "label": "枫丹廷",
    "desc": "枫丹地区角色声库",
    "models": [
     {
      "name": "阿蕾奇诺",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/阿蕾奇诺.zip",
      "size": 412849359,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E9%98%BF%E8%95%BE%E5%A5%87%E8%AF%BA.zip"
     },
     {
      "name": "艾梅莉埃",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/艾梅莉埃.zip",
      "size": 412849822,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E8%89%BE%E6%A2%85%E8%8E%89%E5%9F%83.zip"
     },
     {
      "name": "菲米尼",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/菲米尼.zip",
      "size": 412883649,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E8%8F%B2%E7%B1%B3%E5%B0%BC.zip"
     },
     {
      "name": "芙宁娜",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/芙宁娜.zip",
      "size": 412811232,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E8%8A%99%E5%AE%81%E5%A8%9C.zip"
     },
     {
      "name": "克洛琳德",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/克洛琳德.zip",
      "size": 412911280,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E5%85%8B%E6%B4%9B%E7%90%B3%E5%BE%B7.zip"
     },
     {
      "name": "莱欧斯利",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/莱欧斯利.zip",
      "size": 412878510,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E8%8E%B1%E6%AC%A7%E6%96%AF%E5%88%A9.zip"
     },
     {
      "name": "林尼",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/林尼.zip",
      "size": 412715237,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E6%9E%97%E5%B0%BC.zip"
     },
     {
      "name": "那维莱特",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/那维莱特.zip",
      "size": 412879629,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E9%82%A3%E7%BB%B4%E8%8E%B1%E7%89%B9.zip"
     },
     {
      "name": "娜维娅",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/娜维娅.zip",
      "size": 412894312,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E5%A8%9C%E7%BB%B4%E5%A8%85.zip"
     },
     {
      "name": "千织",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/千织.zip",
      "size": 412853621,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E5%8D%83%E7%BB%87.zip"
     },
     {
      "name": "希格雯",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/希格雯.zip",
      "size": 412830307,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E5%B8%8C%E6%A0%BC%E9%9B%AF.zip"
     },
     {
      "name": "夏沃蕾",
      "work": "原神",
      "workId": "genshin",
      "category": "枫丹廷",
      "desc": "枫丹廷声库",
      "path": "原神/枫丹廷/夏沃蕾.zip",
      "size": 412877469,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9E%AB%E4%B8%B9%E5%BB%B7%2F%E5%A4%8F%E6%B2%83%E8%95%BE.zip"
     }
    ]
   },
   {
    "source": "降临者",
    "label": "降临者",
    "desc": "降临者 / 主角阵营声库",
    "models": [
     {
      "name": "戴因斯雷布",
      "work": "原神",
      "workId": "genshin",
      "category": "降临者",
      "desc": "降临者声库",
      "path": "原神/降临者/戴因斯雷布.zip",
      "size": 412786236,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%99%8D%E4%B8%B4%E8%80%85%2F%E6%88%B4%E5%9B%A0%E6%96%AF%E9%9B%B7%E5%B8%83.zip"
     },
     {
      "name": "空",
      "work": "原神",
      "workId": "genshin",
      "category": "降临者",
      "desc": "降临者声库",
      "path": "原神/降临者/空.zip",
      "size": 412976194,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%99%8D%E4%B8%B4%E8%80%85%2F%E7%A9%BA.zip"
     },
     {
      "name": "派蒙",
      "work": "原神",
      "workId": "genshin",
      "category": "降临者",
      "desc": "降临者声库",
      "path": "原神/降临者/派蒙.zip",
      "size": 412952173,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%99%8D%E4%B8%B4%E8%80%85%2F%E6%B4%BE%E8%92%99.zip"
     },
     {
      "name": "荧",
      "work": "原神",
      "workId": "genshin",
      "category": "降临者",
      "desc": "降临者声库",
      "path": "原神/降临者/荧.zip",
      "size": 413062589,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%99%8D%E4%B8%B4%E8%80%85%2F%E8%8D%A7.zip"
     }
    ]
   },
   {
    "source": "璃月港",
    "label": "璃月港",
    "desc": "璃月地区角色声库",
    "models": [
     {
      "name": "白术",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "双声线，包含白术和长生",
      "path": "原神/璃月港/白术.zip",
      "size": 413165550,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E7%99%BD%E6%9C%AF.zip"
     },
     {
      "name": "北斗",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/北斗.zip",
      "size": 412940969,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E5%8C%97%E6%96%97.zip"
     },
     {
      "name": "达达利亚",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/达达利亚.zip",
      "size": 412998592,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E8%BE%BE%E8%BE%BE%E5%88%A9%E4%BA%9A.zip"
     },
     {
      "name": "甘雨",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/甘雨.zip",
      "size": 412835528,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E7%94%98%E9%9B%A8.zip"
     },
     {
      "name": "胡桃",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/胡桃.zip",
      "size": 412968452,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E8%83%A1%E6%A1%83.zip"
     },
     {
      "name": "嘉明",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/嘉明.zip",
      "size": 412896013,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E5%98%89%E6%98%8E.zip"
     },
     {
      "name": "刻晴",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/刻晴.zip",
      "size": 412906954,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E5%88%BB%E6%99%B4.zip"
     },
     {
      "name": "蓝砚",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/蓝砚.zip",
      "size": 413612035,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E8%93%9D%E7%A0%9A.zip"
     },
     {
      "name": "凝光",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/凝光.zip",
      "size": 413007491,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E5%87%9D%E5%85%89.zip"
     },
     {
      "name": "七七",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/七七.zip",
      "size": 413019449,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E4%B8%83%E4%B8%83.zip"
     },
     {
      "name": "申鹤",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/申鹤.zip",
      "size": 413067447,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E7%94%B3%E9%B9%A4.zip"
     },
     {
      "name": "闲云",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/闲云.zip",
      "size": 413103716,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E9%97%B2%E4%BA%91.zip"
     },
     {
      "name": "香菱",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/香菱.zip",
      "size": 412750557,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E9%A6%99%E8%8F%B1.zip"
     },
     {
      "name": "魈",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/魈.zip",
      "size": 413049669,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E9%AD%88.zip"
     },
     {
      "name": "辛焱",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/辛焱.zip",
      "size": 412974061,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E8%BE%9B%E7%84%B1.zip"
     },
     {
      "name": "行秋",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/行秋.zip",
      "size": 412810272,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E8%A1%8C%E7%A7%8B.zip"
     },
     {
      "name": "烟绯",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/烟绯.zip",
      "size": 413064240,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E7%83%9F%E7%BB%AF.zip"
     },
     {
      "name": "瑶瑶",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/瑶瑶.zip",
      "size": 413019565,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E7%91%B6%E7%91%B6.zip"
     },
     {
      "name": "夜兰",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/夜兰.zip",
      "size": 412884665,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E5%A4%9C%E5%85%B0.zip"
     },
     {
      "name": "云堇",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/云堇.zip",
      "size": 412982662,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E4%BA%91%E5%A0%87.zip"
     },
     {
      "name": "钟离",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/钟离.zip",
      "size": 412924625,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E9%92%9F%E7%A6%BB.zip"
     },
     {
      "name": "重云",
      "work": "原神",
      "workId": "genshin",
      "category": "璃月港",
      "desc": "璃月港声库",
      "path": "原神/璃月港/重云.zip",
      "size": 412733768,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%92%83%E6%9C%88%E6%B8%AF%2F%E9%87%8D%E4%BA%91.zip"
     }
    ]
   },
   {
    "source": "蒙德城",
    "label": "蒙德城",
    "desc": "蒙德地区角色声库",
    "models": [
     {
      "name": "阿贝多",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/阿贝多.zip",
      "size": 412771099,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E9%98%BF%E8%B4%9D%E5%A4%9A.zip"
     },
     {
      "name": "埃洛伊",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/埃洛伊.zip",
      "size": 413045410,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E5%9F%83%E6%B4%9B%E4%BC%8A.zip"
     },
     {
      "name": "安柏",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/安柏.zip",
      "size": 412871068,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E5%AE%89%E6%9F%8F.zip"
     },
     {
      "name": "芭芭拉",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/芭芭拉.zip",
      "size": 412885294,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E8%8A%AD%E8%8A%AD%E6%8B%89.zip"
     },
     {
      "name": "班尼特",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/班尼特.zip",
      "size": 412847760,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E7%8F%AD%E5%B0%BC%E7%89%B9.zip"
     },
     {
      "name": "迪奥娜",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/迪奥娜.zip",
      "size": 412882378,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E8%BF%AA%E5%A5%A5%E5%A8%9C.zip"
     },
     {
      "name": "迪卢克",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/迪卢克.zip",
      "size": 412897641,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E8%BF%AA%E5%8D%A2%E5%85%8B.zip"
     },
     {
      "name": "菲谢尔",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "双声线，包含菲谢尔和奥兹",
      "path": "原神/蒙德城/菲谢尔.zip",
      "size": 412915774,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E8%8F%B2%E8%B0%A2%E5%B0%94.zip"
     },
     {
      "name": "凯亚",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/凯亚.zip",
      "size": 412987485,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E5%87%AF%E4%BA%9A.zip"
     },
     {
      "name": "可莉",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/可莉.zip",
      "size": 412917910,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E5%8F%AF%E8%8E%89.zip"
     },
     {
      "name": "雷泽",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/雷泽.zip",
      "size": 413526095,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E9%9B%B7%E6%B3%BD.zip"
     },
     {
      "name": "丽莎",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/丽莎.zip",
      "size": 412856579,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E4%B8%BD%E8%8E%8E.zip"
     },
     {
      "name": "罗莎莉亚",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/罗莎莉亚.zip",
      "size": 412960392,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E7%BD%97%E8%8E%8E%E8%8E%89%E4%BA%9A.zip"
     },
     {
      "name": "米卡",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/米卡.zip",
      "size": 413078689,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E7%B1%B3%E5%8D%A1.zip"
     },
     {
      "name": "莫娜",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/莫娜.zip",
      "size": 412886986,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E8%8E%AB%E5%A8%9C.zip"
     },
     {
      "name": "诺艾尔",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/诺艾尔.zip",
      "size": 412841944,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E8%AF%BA%E8%89%BE%E5%B0%94.zip"
     },
     {
      "name": "琴",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/琴.zip",
      "size": 412867112,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E7%90%B4.zip"
     },
     {
      "name": "砂糖",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/砂糖.zip",
      "size": 412891360,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E7%A0%82%E7%B3%96.zip"
     },
     {
      "name": "温迪",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/温迪.zip",
      "size": 412919839,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E6%B8%A9%E8%BF%AA.zip"
     },
     {
      "name": "优菈",
      "work": "原神",
      "workId": "genshin",
      "category": "蒙德城",
      "desc": "蒙德城声库",
      "path": "原神/蒙德城/优菈.zip",
      "size": 412817458,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E8%92%99%E5%BE%B7%E5%9F%8E%2F%E4%BC%98%E8%8F%88.zip"
     }
    ]
   },
   {
    "source": "纳塔",
    "label": "纳塔",
    "desc": "纳塔地区角色声库（上游暂未上传权重）",
    "models": [
     {
      "name": "基尼奇",
      "work": "原神",
      "workId": "genshin",
      "category": "纳塔",
      "desc": "双声线，包含基尼奇和阿乔",
      "path": "原神/纳塔/基尼奇.zip",
      "size": 134,
      "placeholder": true,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%BA%B3%E5%A1%94%2F%E5%9F%BA%E5%B0%BC%E5%A5%87.zip"
     },
     {
      "name": "卡齐娜",
      "work": "原神",
      "workId": "genshin",
      "category": "纳塔",
      "desc": "纳塔声库",
      "path": "原神/纳塔/卡齐娜.zip",
      "size": 134,
      "placeholder": true,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%BA%B3%E5%A1%94%2F%E5%8D%A1%E9%BD%90%E5%A8%9C.zip"
     },
     {
      "name": "玛拉妮",
      "work": "原神",
      "workId": "genshin",
      "category": "纳塔",
      "desc": "纳塔声库",
      "path": "原神/纳塔/玛拉妮.zip",
      "size": 134,
      "placeholder": true,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%BA%B3%E5%A1%94%2F%E7%8E%9B%E6%8B%89%E5%A6%AE.zip"
     },
     {
      "name": "玛薇卡",
      "work": "原神",
      "workId": "genshin",
      "category": "纳塔",
      "desc": "纳塔声库",
      "path": "原神/纳塔/玛薇卡.zip",
      "size": 134,
      "placeholder": true,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%BA%B3%E5%A1%94%2F%E7%8E%9B%E8%96%87%E5%8D%A1.zip"
     },
     {
      "name": "恰斯卡",
      "work": "原神",
      "workId": "genshin",
      "category": "纳塔",
      "desc": "纳塔声库",
      "path": "原神/纳塔/恰斯卡.zip",
      "size": 134,
      "placeholder": true,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%BA%B3%E5%A1%94%2F%E6%81%B0%E6%96%AF%E5%8D%A1.zip"
     },
     {
      "name": "茜特菈莉",
      "work": "原神",
      "workId": "genshin",
      "category": "纳塔",
      "desc": "纳塔声库",
      "path": "原神/纳塔/茜特菈莉.zip",
      "size": 134,
      "placeholder": true,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%BA%B3%E5%A1%94%2F%E8%8C%9C%E7%89%B9%E8%8F%88%E8%8E%89.zip"
     },
     {
      "name": "希诺宁",
      "work": "原神",
      "workId": "genshin",
      "category": "纳塔",
      "desc": "纳塔声库",
      "path": "原神/纳塔/希诺宁.zip",
      "size": 134,
      "placeholder": true,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%BA%B3%E5%A1%94%2F%E5%B8%8C%E8%AF%BA%E5%AE%81.zip"
     },
     {
      "name": "伊安珊",
      "work": "原神",
      "workId": "genshin",
      "category": "纳塔",
      "desc": "纳塔声库",
      "path": "原神/纳塔/伊安珊.zip",
      "size": 134,
      "placeholder": true,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E7%BA%B3%E5%A1%94%2F%E4%BC%8A%E5%AE%89%E7%8F%8A.zip"
     }
    ]
   },
   {
    "source": "未分类",
    "label": "未分类",
    "desc": "未归入地区分类的声库",
    "models": [
     {
      "name": "阿乔",
      "work": "原神",
      "workId": "genshin",
      "category": "未分类",
      "desc": "未分类声库",
      "path": "原神/未分类/阿乔.zip",
      "size": 412413298,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9C%AA%E5%88%86%E7%B1%BB%2F%E9%98%BF%E4%B9%94.zip"
     },
     {
      "name": "奥兹",
      "work": "原神",
      "workId": "genshin",
      "category": "未分类",
      "desc": "未分类声库",
      "path": "原神/未分类/奥兹.zip",
      "size": 412411105,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9C%AA%E5%88%86%E7%B1%BB%2F%E5%A5%A5%E5%85%B9.zip"
     },
     {
      "name": "长生",
      "work": "原神",
      "workId": "genshin",
      "category": "未分类",
      "desc": "未分类声库",
      "path": "原神/未分类/长生.zip",
      "size": 412416451,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E6%9C%AA%E5%88%86%E7%B1%BB%2F%E9%95%BF%E7%94%9F.zip"
     }
    ]
   },
   {
    "source": "须弥城",
    "label": "须弥城",
    "desc": "须弥地区角色声库",
    "models": [
     {
      "name": "迪希雅",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/迪希雅.zip",
      "size": 412895191,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E8%BF%AA%E5%B8%8C%E9%9B%85.zip"
     },
     {
      "name": "多莉",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/多莉.zip",
      "size": 413070828,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E5%A4%9A%E8%8E%89.zip"
     },
     {
      "name": "珐露珊",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/珐露珊.zip",
      "size": 412970877,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E7%8F%90%E9%9C%B2%E7%8F%8A.zip"
     },
     {
      "name": "卡维",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/卡维.zip",
      "size": 412964708,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E5%8D%A1%E7%BB%B4.zip"
     },
     {
      "name": "坎蒂丝",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/坎蒂丝.zip",
      "size": 413365976,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E5%9D%8E%E8%92%82%E4%B8%9D.zip"
     },
     {
      "name": "柯莱",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/柯莱.zip",
      "size": 412997473,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E6%9F%AF%E8%8E%B1.zip"
     },
     {
      "name": "莱依拉",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/莱依拉.zip",
      "size": 413418280,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E8%8E%B1%E4%BE%9D%E6%8B%89.zip"
     },
     {
      "name": "纳西妲",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/纳西妲.zip",
      "size": 413177894,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E7%BA%B3%E8%A5%BF%E5%A6%B2.zip"
     },
     {
      "name": "妮露",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/妮露.zip",
      "size": 413125784,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E5%A6%AE%E9%9C%B2.zip"
     },
     {
      "name": "赛诺",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/赛诺.zip",
      "size": 413078719,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E8%B5%9B%E8%AF%BA.zip"
     },
     {
      "name": "赛索斯",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/赛索斯.zip",
      "size": 413095854,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E8%B5%9B%E7%B4%A2%E6%96%AF.zip"
     },
     {
      "name": "提纳里",
      "work": "原神",
      "workId": "genshin",
      "category": "须弥城",
      "desc": "须弥城声库",
      "path": "原神/须弥城/提纳里.zip",
      "size": 413051056,
      "placeholder": false,
      "url": "https://www.modelscope.cn/api/v1/models/aihobbyist/ACG-DiffSinger-VoiceDB/repo?Revision=master&FilePath=%E5%8E%9F%E7%A5%9E%2F%E9%A1%BB%E5%BC%A5%E5%9F%8E%2F%E6%8F%90%E7%BA%B3%E9%87%8C.zip"
     }
    ]
   }
  ]
 }
];

/** 分组统计，供 UI 直接展示 */
const STATS = {
  "total": 171,
  "available": 163,
  "placeholder": 8,
  "works": [
    {
      "id": "starrail",
      "label": "崩坏：星穹铁道",
      "source": "星穹铁道",
      "models": 74,
      "categories": 5
    },
    {
      "id": "genshin",
      "label": "原神",
      "source": "原神",
      "models": 97,
      "categories": 8
    }
  ]
};

/** 扁平化索引：path → model，便于快速查重与下载 */
const BY_PATH = new Map();
for (const w of WORKS) for (const c of w.categories) for (const m of c.models) BY_PATH.set(m.path, m);

module.exports = { MS_REPO, WORKS, STATS, BY_PATH, msFileUrl };
