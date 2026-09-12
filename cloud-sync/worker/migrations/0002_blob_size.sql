-- 记录 R2 中该曲目的实际字节数，用于判断"云端是否真的存了内容"。
-- 仅靠 meta.size（客户端上报的本地文件大小）无法区分"已备份"与"只有元数据的空壳行"，
-- 之前的同步就因此把 99 首只写了元数据却显示为已备份。
ALTER TABLE songs ADD COLUMN blob_size INTEGER NOT NULL DEFAULT 0;
