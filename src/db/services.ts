import { getDb } from './index';

export interface User {
    userId: number;
    username: string;
    language: 'en' | 'zh';
    isSubscribed: number;
    activePartitionId: number | null;
    connectedToUserId: number | null;
}

export interface Partition {
    id: number;
    name: string;
    userId: number;
}

export interface PartitionWithStats extends Partition {
    documentCount: number;
}

export interface PartitionSettings {
    partitionId: number;
    personaPrompt: string;
    questionMode: 'auto' | 'clarify-first' | 'answer-first';
    replyStyle: 'concise' | 'balanced' | 'detailed';
    knowledgeMode: 'strict' | 'hybrid';
    citationMode: number;
    updatedAt?: string;
}

export interface GroupBindingSettings {
    replyStyle: PartitionSettings['replyStyle'];
    knowledgeMode: PartitionSettings['knowledgeMode'];
    citationMode: number;
    accessMode: 'all_members' | 'admins_only';
    triggerMode: 'mention_only' | 'mention_or_reply' | 'mention_reply_slash';
}

export interface GroupBinding extends GroupBindingSettings {
    chatId: number;
    ownerUserId: number;
    partitionId: number | null;
    updatedBy: number | null;
    updatedAt?: string;
    ownerUsername?: string;
    partitionName?: string | null;
}

const DEFAULT_PARTITION_SETTINGS: Omit<PartitionSettings, 'partitionId' | 'updatedAt'> = {
    personaPrompt: '',
    questionMode: 'auto',
    replyStyle: 'balanced',
    knowledgeMode: 'hybrid',
    citationMode: 1,
};

const DEFAULT_GROUP_BINDING_SETTINGS: GroupBindingSettings = {
    replyStyle: 'concise',
    knowledgeMode: 'strict',
    citationMode: 1,
    accessMode: 'all_members',
    triggerMode: 'mention_reply_slash',
};

function normalizeInviteCode(code: string) {
    return code.trim().toUpperCase();
}

// ===== User CRUD =====

export async function getUser(userId: number): Promise<User | null> {
    const db = getDb();
    const user = await db.get('SELECT * FROM Users WHERE userId = ?', [userId]);
    return user || null;
}

export async function createUser(userId: number, username: string, language: 'en' | 'zh' = 'zh') {
    const db = getDb();
    await db.run(
        'INSERT OR IGNORE INTO Users (userId, username, language, isSubscribed) VALUES (?, ?, ?, 0)',
        [userId, username, language]
    );
}

export async function updateUserLanguage(userId: number, language: 'en' | 'zh') {
    const db = getDb();
    await db.run('UPDATE Users SET language = ? WHERE userId = ?', [language, userId]);
}

export async function subscribeUser(userId: number) {
    const db = getDb();
    await db.run('UPDATE Users SET isSubscribed = 1 WHERE userId = ?', [userId]);
}

export async function setActivePartition(userId: number, partitionId: number | null) {
    const db = getDb();
    await db.run('UPDATE Users SET activePartitionId = ? WHERE userId = ?', [partitionId, userId]);
}

// ===== Partitions =====

export async function createPartition(userId: number, name: string) {
    const db = getDb();
    const result = await db.run('INSERT INTO Partitions (name, userId) VALUES (?, ?)', [name, userId]);
    if (result.lastID) {
        await db.run(
            `INSERT OR IGNORE INTO PartitionSettings
             (partitionId, personaPrompt, questionMode, replyStyle, knowledgeMode, citationMode)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                result.lastID,
                DEFAULT_PARTITION_SETTINGS.personaPrompt,
                DEFAULT_PARTITION_SETTINGS.questionMode,
                DEFAULT_PARTITION_SETTINGS.replyStyle,
                DEFAULT_PARTITION_SETTINGS.knowledgeMode,
                DEFAULT_PARTITION_SETTINGS.citationMode,
            ]
        );
    }
    return result.lastID;
}

export async function getUserPartitions(userId: number) {
    const db = getDb();
    return db.all('SELECT * FROM Partitions WHERE userId = ?', [userId]);
}

export async function getUserPartitionsWithStats(userId: number): Promise<PartitionWithStats[]> {
    const db = getDb();
    const rows = await db.all(
        `SELECT p.id, p.name, p.userId, COUNT(d.id) as documentCount
         FROM Partitions p
         LEFT JOIN Documents d ON d.partitionId = p.id
         WHERE p.userId = ?
         GROUP BY p.id
         ORDER BY p.id ASC`,
        [userId]
    ) as Array<PartitionWithStats & { documentCount?: number }>;

    return rows.map((row) => ({
        ...row,
        documentCount: Number(row.documentCount || 0),
    }));
}

export async function getPartitionById(userId: number, partitionId: number): Promise<Partition | null> {
    const db = getDb();
    const partition = await db.get(
        'SELECT * FROM Partitions WHERE userId = ? AND id = ?',
        [userId, partitionId]
    );
    return partition || null;
}

async function ensurePartitionSettings(partitionId: number) {
    const db = getDb();
    await db.run(
        `INSERT OR IGNORE INTO PartitionSettings
         (partitionId, personaPrompt, questionMode, replyStyle, knowledgeMode, citationMode)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            partitionId,
            DEFAULT_PARTITION_SETTINGS.personaPrompt,
            DEFAULT_PARTITION_SETTINGS.questionMode,
            DEFAULT_PARTITION_SETTINGS.replyStyle,
            DEFAULT_PARTITION_SETTINGS.knowledgeMode,
            DEFAULT_PARTITION_SETTINGS.citationMode,
        ]
    );
}

export async function getPartitionSettings(partitionId: number): Promise<PartitionSettings> {
    const db = getDb();
    await ensurePartitionSettings(partitionId);
    const row = await db.get('SELECT * FROM PartitionSettings WHERE partitionId = ?', [partitionId]);
    return {
        partitionId,
        ...DEFAULT_PARTITION_SETTINGS,
        ...row,
    };
}

export async function updatePartitionSettings(
    partitionId: number,
    updates: Partial<Omit<PartitionSettings, 'partitionId' | 'updatedAt'>>
): Promise<PartitionSettings> {
    const db = getDb();
    await ensurePartitionSettings(partitionId);

    const current = await getPartitionSettings(partitionId);
    const next = {
        ...current,
        ...updates,
    };

    await db.run(
        `UPDATE PartitionSettings
         SET personaPrompt = ?, questionMode = ?, replyStyle = ?, knowledgeMode = ?, citationMode = ?, updatedAt = datetime('now')
         WHERE partitionId = ?`,
        [
            next.personaPrompt,
            next.questionMode,
            next.replyStyle,
            next.knowledgeMode,
            next.citationMode,
            partitionId,
        ]
    );

    return getPartitionSettings(partitionId);
}

export async function addDocument(fileId: string, fileName: string, partitionId: number) {
    const db = getDb();
    await db.run(
        'INSERT INTO Documents (fileId, fileName, storageType, localPath, storageUrl, partitionId) VALUES (?, ?, ?, ?, ?, ?)',
        [fileId, fileName, 'telegram', null, null, partitionId]
    );
}

interface DocumentStorageMeta {
    storageType?: 'telegram' | 'local' | 'cos';
    localPath?: string | null;
    storageUrl?: string | null;
}

export async function addDocumentWithStorage(
    fileId: string,
    fileName: string,
    partitionId: number,
    storage: DocumentStorageMeta
) {
    const db = getDb();
    await db.run(
        'INSERT INTO Documents (fileId, fileName, storageType, localPath, storageUrl, partitionId) VALUES (?, ?, ?, ?, ?, ?)',
        [
            fileId,
            fileName,
            storage.storageType || 'telegram',
            storage.localPath || null,
            storage.storageUrl || null,
            partitionId,
        ]
    );
}

export async function getPartitionDocumentCount(partitionId: number): Promise<number> {
    const db = getDb();
    const row = await db.get(
        'SELECT COUNT(*) as cnt FROM Documents WHERE partitionId = ?',
        [partitionId]
    );
    return row?.cnt || 0;
}

export async function getDocumentCountForUser(userId: number): Promise<number> {
    const db = getDb();
    const result = await db.get(
        'SELECT COUNT(*) as cnt FROM Documents d JOIN Partitions p ON d.partitionId = p.id WHERE p.userId = ?',
        [userId]
    );
    return result?.cnt || 0;
}

// ===== Invite Codes =====

export async function setInviteCode(userId: number, customCode: string): Promise<{ success: boolean; error?: string }> {
    const db = getDb();
    const normalized = normalizeInviteCode(customCode);
    if (normalized.length < 2 || normalized.length > 20) {
        return { success: false, error: 'length' };
    }
    // Check if this code is already taken by someone else
    const existing = await db.get('SELECT ownerUserId FROM InviteCodes WHERE UPPER(code) = ?', [normalized]);
    if (existing && existing.ownerUserId !== userId) {
        return { success: false, error: 'taken' };
    }
    // Delete old code if user already has one
    await db.run('DELETE FROM InviteCodes WHERE ownerUserId = ?', [userId]);
    // Insert new code
    await db.run('INSERT INTO InviteCodes (code, ownerUserId) VALUES (?, ?)', [normalized, userId]);
    return { success: true };
}

export async function getInviteCode(userId: number): Promise<string | null> {
    const db = getDb();
    const row = await db.get('SELECT code FROM InviteCodes WHERE ownerUserId = ?', [userId]);
    return row?.code || null;
}

export async function resolveInviteCode(code: string): Promise<{ ownerUserId: number; username: string } | null> {
    const db = getDb();
    const normalized = normalizeInviteCode(code);
    const row = await db.get(
        'SELECT ic.ownerUserId, u.username FROM InviteCodes ic JOIN Users u ON ic.ownerUserId = u.userId WHERE UPPER(ic.code) = ?',
        [normalized]
    );
    return row || null;
}

// ===== Connection (访客模式) =====

export async function connectToBook(userId: number, ownerUserId: number) {
    const db = getDb();
    await db.run('UPDATE Users SET connectedToUserId = ? WHERE userId = ?', [ownerUserId, userId]);
}

export async function disconnectFromBook(userId: number) {
    const db = getDb();
    await db.run('UPDATE Users SET connectedToUserId = NULL WHERE userId = ?', [userId]);
}

// ===== Group Bindings =====

function mapGroupBinding(row: any): GroupBinding {
    return {
        chatId: row.chatId,
        ownerUserId: row.boundUserId,
        partitionId: typeof row.partitionId === 'number' ? row.partitionId : row.partitionId ?? null,
        replyStyle: row.replyStyle || DEFAULT_GROUP_BINDING_SETTINGS.replyStyle,
        knowledgeMode: row.knowledgeMode || DEFAULT_GROUP_BINDING_SETTINGS.knowledgeMode,
        citationMode: Number(row.citationMode ?? DEFAULT_GROUP_BINDING_SETTINGS.citationMode),
        accessMode: row.accessMode || DEFAULT_GROUP_BINDING_SETTINGS.accessMode,
        triggerMode: row.triggerMode || DEFAULT_GROUP_BINDING_SETTINGS.triggerMode,
        updatedBy: typeof row.updatedBy === 'number' ? row.updatedBy : row.updatedBy ?? null,
        updatedAt: row.updatedAt,
        ownerUsername: row.ownerUsername,
        partitionName: row.partitionName ?? null,
    };
}

export async function bindGroupToUser(
    chatId: number,
    ownerUserId: number,
    partitionId: number,
    updates: Partial<GroupBindingSettings> = {},
    updatedBy: number | null = ownerUserId
) {
    const db = getDb();
    const current = await getGroupBinding(chatId);
    const next = {
        ...DEFAULT_GROUP_BINDING_SETTINGS,
        ...(current || {}),
        ...updates,
    };

    await db.run(
        `INSERT OR IGNORE INTO GroupBindings
         (chatId, boundUserId, partitionId, replyStyle, knowledgeMode, citationMode, accessMode, triggerMode, updatedBy, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
            chatId,
            ownerUserId,
            partitionId,
            next.replyStyle,
            next.knowledgeMode,
            next.citationMode,
            next.accessMode,
            next.triggerMode,
            updatedBy,
        ]
    );
    await db.run(
        `UPDATE GroupBindings
         SET boundUserId = ?, partitionId = ?, replyStyle = ?, knowledgeMode = ?, citationMode = ?, accessMode = ?, triggerMode = ?, updatedBy = ?, updatedAt = datetime('now')
         WHERE chatId = ?`,
        [
            ownerUserId,
            partitionId,
            next.replyStyle,
            next.knowledgeMode,
            next.citationMode,
            next.accessMode,
            next.triggerMode,
            updatedBy,
            chatId,
        ]
    );

    return await getGroupBinding(chatId);
}

export async function getGroupBinding(chatId: number): Promise<GroupBinding | null> {
    const db = getDb();
    const row = await db.get(
        `SELECT gb.*, u.username as ownerUsername, p.name as partitionName
         FROM GroupBindings gb
         LEFT JOIN Users u ON u.userId = gb.boundUserId
         LEFT JOIN Partitions p ON p.id = gb.partitionId
         WHERE gb.chatId = ?`,
        [chatId]
    );
    return row ? mapGroupBinding(row) : null;
}

export async function updateGroupBindingSettings(
    chatId: number,
    updates: Partial<GroupBindingSettings>,
    updatedBy: number | null
): Promise<GroupBinding | null> {
    const db = getDb();
    const current = await getGroupBinding(chatId);
    if (!current) {
        return null;
    }

    const next = {
        ...DEFAULT_GROUP_BINDING_SETTINGS,
        ...current,
        ...updates,
    };

    await db.run(
        `UPDATE GroupBindings
         SET replyStyle = ?, knowledgeMode = ?, citationMode = ?, accessMode = ?, triggerMode = ?, updatedBy = ?, updatedAt = datetime('now')
         WHERE chatId = ?`,
        [
            next.replyStyle,
            next.knowledgeMode,
            next.citationMode,
            next.accessMode,
            next.triggerMode,
            updatedBy,
            chatId,
        ]
    );

    return await getGroupBinding(chatId);
}

export async function updateGroupBindingPartition(
    chatId: number,
    partitionId: number,
    updatedBy: number | null
): Promise<GroupBinding | null> {
    const db = getDb();
    await db.run(
        `UPDATE GroupBindings
         SET partitionId = ?, updatedBy = ?, updatedAt = datetime('now')
         WHERE chatId = ?`,
        [partitionId, updatedBy, chatId]
    );
    return await getGroupBinding(chatId);
}

export async function unbindGroup(chatId: number) {
    const db = getDb();
    await db.run('DELETE FROM GroupBindings WHERE chatId = ?', [chatId]);
}
