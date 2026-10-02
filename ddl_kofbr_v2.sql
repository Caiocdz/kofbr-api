-- ============================================================
-- KOFBR (Gargalo x Coca-Cola) — DDL MySQL 8.0+
-- Versão: 2.0 — 24/09/2026
--
-- Sistema de normalização inteligente de apontamentos de falha
-- importados do SAP, com motor de deduplicação TF-IDF local,
-- confirmação humana e dashboards analíticos (Pareto / Jack-Knife).
--
-- Charset utf8mb4 obrigatório: as observações de campo dos
-- operadores contêm acentuação, cedilha e abreviações livres.
-- ============================================================

CREATE DATABASE IF NOT EXISTS kofbr
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE kofbr;


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║  1. TABELAS DE SUPORTE (sem FK para outras tabelas KOFBR)    ║
-- ╚═══════════════════════════════════════════════════════════════╝

-- ------------------------------------------------------------
-- 1.1  upload_batches
-- Cada upload de planilha .xlsx/.xlsm gera um lote.
-- A interface "Meu Drive Diário" lista estes registros.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS upload_batches (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    file_hash       VARCHAR(32),
    content_hash    CHAR(64),
    filename        VARCHAR(255)    NOT NULL    COMMENT 'Nome original do arquivo enviado pelo usuário',
    total_records   INT UNSIGNED    NOT NULL    DEFAULT 0 COMMENT 'Qtd de linhas importadas da planilha',
    created_at      DATETIME        NOT NULL    DEFAULT CURRENT_TIMESTAMP COMMENT 'Momento do upload',

    INDEX idx_ub_created (created_at DESC),
    INDEX idx_upload_content_hash (content_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Lotes de importação de planilhas SAP';


-- ------------------------------------------------------------
-- 1.2  canonical_failures
-- Taxonomia consolidada de modos de falha. Criada quando o
-- humano confirma um cluster — cada nome sugerido vira um
-- "modo de falha canônico" que pode ser reaproveitado.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_failures (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    nome_canonico   VARCHAR(255)    NOT NULL    COMMENT 'Nome padronizado do modo de falha',
    linha           VARCHAR(100)                COMMENT 'Linha de produção (ex: LINHA004, MULTI009)',
    equipamento     VARCHAR(255)                COMMENT 'Equipamento (ex: ENVOLVEDORA SID LI04)',
    created_at      DATETIME        NOT NULL    DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_cf_nome     (nome_canonico),
    INDEX idx_cf_linha_eq (linha, equipamento)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Modos de falha consolidados (taxonomia confirmada por humano)';


-- ------------------------------------------------------------
-- 1.3  radio_channels
-- Configuração de canal de rádio por linha + turno.
-- Preenchida manualmente (uma vez) ou importada de planilha.
-- Usada no endpoint "Questionar" para indicar como contactar
-- o operador responsável pelo apontamento.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS radio_channels (
    linha   VARCHAR(100)    NOT NULL COMMENT 'Linha de produção',
    turno   VARCHAR(20)     NOT NULL COMMENT 'Turno (ex: 1, 2, 3 ou Manhã, Tarde, Noite)',
    canal   VARCHAR(20)     NOT NULL COMMENT 'Canal do rádio HT',

    PRIMARY KEY (linha, turno)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Mapeamento linha+turno → canal de rádio (config)';


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║  2. TABELA PRINCIPAL: RECORDS (apontamentos de falha SAP)     ║
-- ╚═══════════════════════════════════════════════════════════════╝

-- ------------------------------------------------------------
-- 2.1  records
-- Um registro por apontamento de falha importado da planilha.
-- Os campos correspondem às colunas exportadas do SAP (layout
-- acordado com o time da Taís/KOF BR).
--
-- Fluxo de status:
--   pending   → recém-importado, aguardando processamento
--   confirmed → o cluster ao qual pertence foi confirmado
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS records (
    id                      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    -- ── Dados estruturados do SAP ──
    centro                  VARCHAR(100)            COMMENT 'Centro de custo / unidade fabril',
    data_inicio             DATETIME                COMMENT 'Data/hora de início da parada',
    linha                   VARCHAR(100)            COMMENT 'Linha de produção (ex: LINHA004)',
    tipo_parada             VARCHAR(100)            COMMENT 'Classificação SAP (P.EQ.LINHA, P.EQ.EQUIP...)',
    material                VARCHAR(100)            COMMENT 'Código do material / SKU',
    ordem                   VARCHAR(50)             COMMENT 'Número da ordem de produção SAP',
    descricao_material      VARCHAR(255)            COMMENT 'Descrição textual do material',
    turno                   VARCHAR(20)             COMMENT 'Turno do operador (1/2/3 ou texto)',
    intervalo               VARCHAR(50)             COMMENT 'Faixa horária do apontamento',
    equipamento             VARCHAR(255)            COMMENT 'Equipamento que parou (chave de parada SAP)',
    subchave_parada         VARCHAR(255)            COMMENT 'Subclassificação da parada',
    sistema                 VARCHAR(255)            COMMENT 'Chave 1 de parada (sistema SAP)',

    -- ── Observação do operador ──
    observacao_raw          TEXT                    COMMENT 'Texto livre original do operador',
    observacao_normalizada  TEXT                    COMMENT 'Resultado do pipeline normalize_observation()',
    operador                VARCHAR(150)            COMMENT 'Nome do operador (pode ser NULL se SAP não exporta)',

    -- ── Vínculo com taxonomia consolidada ──
    canonical_failure_id    INT UNSIGNED            COMMENT 'FK para o modo de falha canônico (pós-confirmação)',

    -- ── Métricas numéricas SAP ──
    pts_efic_perdidos       DECIMAL(12,2)           COMMENT 'Pontos de eficiência perdidos',
    pts_acumulados          DECIMAL(12,2)           COMMENT 'Pontos acumulados no período',
    caixas_produzidas       DECIMAL(12,2)           COMMENT 'Caixas produzidas no período',
    total_minutos           DECIMAL(12,2)           COMMENT 'Tempo total disponível (min)',
    minutos_parada          DECIMAL(12,2)           COMMENT 'Duração da parada (min)',

    -- ── Controle interno ──
    status                  ENUM('pending','confirmed')
                            NOT NULL DEFAULT 'pending'
                            COMMENT 'pending=aguarda dedup, confirmed=cluster confirmado',
    question_flag           TINYINT(1) UNSIGNED
                            NOT NULL DEFAULT 0
                            COMMENT '1=operador foi questionado via rádio',
    question_note           TEXT                    COMMENT 'Nota de dúvida registrada pelo analista',
    upload_batch_id         INT UNSIGNED            COMMENT 'FK para o lote de importação',
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                            COMMENT 'Momento da inserção no banco',

    -- ── Foreign Keys ──
    CONSTRAINT fk_records_canonical
        FOREIGN KEY (canonical_failure_id) REFERENCES canonical_failures(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,

    CONSTRAINT fk_records_batch
        FOREIGN KEY (upload_batch_id) REFERENCES upload_batches(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,

    -- ── Índices otimizados para as queries da API ──
    INDEX idx_rec_linha_equip    (linha, equipamento),           -- Pareto, Jack-Knife
    INDEX idx_rec_status         (status),                       -- Motor de dedup (WHERE status='pending')
    INDEX idx_rec_canonical      (canonical_failure_id),         -- JOIN com canonical_failures
    INDEX idx_rec_question       (question_flag),                -- Listar questionados
    INDEX idx_rec_data_inicio    (data_inicio),                  -- Filtros por período
    INDEX idx_rec_linha_turno    (linha, turno),                 -- Canal de rádio + filtro turno
    INDEX idx_rec_batch          (upload_batch_id),              -- Listar registros por lote
    INDEX idx_rec_tipo_parada    (tipo_parada),                  -- Filtro por tipo de parada no Drive
    INDEX idx_rec_turno          (turno)                         -- Filtro turno isolado no Drive

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Apontamentos de falha importados do SAP — tabela principal';


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║  3. TABELAS DE AGRUPAMENTO E JOBS ASSÍNCRONOS                 ║
-- ╚═══════════════════════════════════════════════════════════════╝

-- ------------------------------------------------------------
-- 3.1  dedup_jobs
-- Cada execução do motor de deduplicação (POST /api/dedup/run)
-- gera um job. A API faz polling em /api/dedup/status/<id>.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dedup_jobs (
    id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    status               ENUM('running','done','error')
                         NOT NULL DEFAULT 'running'
                         COMMENT 'Estado atual do job',
    started_at           DATETIME        NOT NULL    COMMENT 'Início do processamento',
    finished_at          DATETIME                    COMMENT 'Fim do processamento (NULL se running)',
    registros_analisados INT UNSIGNED                COMMENT 'Total de records pending analisados',
    propostas_criadas    INT UNSIGNED                COMMENT 'Total de clusters gerados',
    erro                 TEXT                        COMMENT 'Stack trace em caso de falha',

    INDEX idx_dj_status   (status),
    INDEX idx_dj_started  (started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Jobs de deduplicação (análise de similaridade TF-IDF)';


-- ------------------------------------------------------------
-- 3.2  bulk_confirm_jobs
-- Job assíncrono de "Aceitar Todas" as propostas pendentes.
-- POST /api/clusters/confirm-all → cria o job → thread processa.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bulk_confirm_jobs (
    id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    status            ENUM('running','done','error')
                      NOT NULL DEFAULT 'running'
                      COMMENT 'Estado atual do job',
    started_at        DATETIME        NOT NULL    COMMENT 'Início do processamento',
    finished_at       DATETIME                    COMMENT 'Fim do processamento',
    total_confirmadas INT UNSIGNED                COMMENT 'Clusters confirmados nesta rodada',
    erro              TEXT                        COMMENT 'Stack trace em caso de falha',

    INDEX idx_bcj_status  (status),
    INDEX idx_bcj_started (started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Jobs de confirmação em massa de clusters';


-- ------------------------------------------------------------
-- 3.3  clusters
-- Propostas de agrupamento geradas pelo motor de dedup.
-- Cada cluster reúne N records com observações similares,
-- sugerindo um nome padronizado (suggested_name).
--
-- Fluxo de status:
--   pending   → proposta gerada, aguardando revisão humana
--   confirmed → aceita pelo analista (records foram vinculados)
--   rejected  → descartada pelo analista
--
-- A coluna confirmed_at alimenta o "Meu Drive Diário",
-- que agrupa os clusters confirmados por DATE(confirmed_at).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clusters (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    linha               VARCHAR(100)                COMMENT 'Linha de produção do grupo',
    equipamento         VARCHAR(255)                COMMENT 'Equipamento do grupo',
    suggested_name      VARCHAR(255)                COMMENT 'Nome canônico sugerido pelo motor',
    member_record_ids   JSON            NOT NULL    COMMENT 'Array JSON de IDs de records, ex: [12,15,19]',
    avg_similarity      DECIMAL(5,3)                COMMENT 'Similaridade média (cosseno) entre membros (0-1)',
    status              ENUM('pending','confirmed','rejected')
                        NOT NULL DEFAULT 'pending'
                        COMMENT 'Estado da proposta',
    bulk_job_id         INT UNSIGNED                COMMENT 'FK opcional para bulk_confirm_jobs (se veio de confirm-all)',
    confirmed_at        DATETIME                    COMMENT 'Momento da confirmação humana (NULL se não confirmado)',
    created_at          DATETIME        NOT NULL    DEFAULT CURRENT_TIMESTAMP
                        COMMENT 'Momento da criação da proposta',

    -- ── Foreign Key ──
    CONSTRAINT fk_clusters_bulk_job
        FOREIGN KEY (bulk_job_id) REFERENCES bulk_confirm_jobs(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,

    -- ── Índices otimizados ──
    INDEX idx_cl_status         (status),                        -- Listar pendentes / confirmados
    INDEX idx_cl_linha_equip    (linha, equipamento),             -- Filtros do Drive
    INDEX idx_cl_bulk_job       (bulk_job_id),                   -- Vincular ao job em massa
    INDEX idx_cl_confirmed_at   (confirmed_at),                  -- Drive Diário (GROUP BY DATE)
    INDEX idx_cl_status_conf    (status, confirmed_at DESC)      -- Histórico: WHERE confirmed + ORDER BY date
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Propostas de agrupamento de falhas (deduplicação)';


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║  4. VIEWS ANALÍTICAS (consultas frequentes pré-prontas)       ║
-- ╚═══════════════════════════════════════════════════════════════╝

-- ------------------------------------------------------------
-- 4.1  vw_drive_diario
-- Alimenta a tela principal "Meu Drive Diário".
-- Agrupa clusters confirmados por dia, contando quantos tem.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_drive_diario AS
SELECT
    DATE(c.confirmed_at)        AS data_analise,
    COUNT(c.id)                 AS total_clusters,
    SUM(
        JSON_LENGTH(c.member_record_ids)
    )                           AS total_apontamentos
FROM clusters c
WHERE c.status = 'confirmed'
  AND c.confirmed_at IS NOT NULL
GROUP BY DATE(c.confirmed_at)
ORDER BY data_analise DESC;


-- ------------------------------------------------------------
-- 4.2  vw_pareto_equipamento
-- Ranking dos equipamentos que mais geram parada (em minutos),
-- usado pelo endpoint /api/dashboard/pareto.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_pareto_equipamento AS
SELECT
    r.linha,
    r.equipamento,
    COUNT(*)                                AS total_ocorrencias,
    COALESCE(SUM(r.minutos_parada), 0)      AS total_minutos_parada,
    COALESCE(SUM(r.pts_efic_perdidos), 0)   AS total_pts_perdidos,
    ROUND(
        COUNT(*) * 100.0 /
        NULLIF((SELECT COUNT(*) FROM records r2 WHERE r2.linha = r.linha), 0)
    , 2)                                    AS percentual_linha
FROM records r
WHERE r.equipamento IS NOT NULL
  AND r.equipamento != ''
GROUP BY r.linha, r.equipamento
ORDER BY total_minutos_parada DESC;


-- ------------------------------------------------------------
-- 4.3  vw_resumo_importacoes
-- Visão geral de todas as importações (para auditoria e
-- acompanhamento do fluxo de dados).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_resumo_importacoes AS
SELECT
    ub.id                       AS batch_id,
    ub.filename,
    ub.total_records            AS registros_importados,
    ub.created_at               AS data_importacao,
    SUM(CASE WHEN r.status = 'pending'   THEN 1 ELSE 0 END) AS pendentes,
    SUM(CASE WHEN r.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmados,
    SUM(CASE WHEN r.question_flag = 1    THEN 1 ELSE 0 END) AS questionados
FROM upload_batches ub
LEFT JOIN records r ON r.upload_batch_id = ub.id
GROUP BY ub.id, ub.filename, ub.total_records, ub.created_at
ORDER BY ub.created_at DESC;


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║  5. PROCEDURES UTILITÁRIAS                                    ║
-- ╚═══════════════════════════════════════════════════════════════╝

DELIMITER //

-- ------------------------------------------------------------
-- 5.1  sp_limpar_clusters_rejeitados
-- Remove clusters descartados com mais de N dias.
-- Uso: CALL sp_limpar_clusters_rejeitados(30);
-- ------------------------------------------------------------
CREATE PROCEDURE IF NOT EXISTS sp_limpar_clusters_rejeitados(
    IN p_dias_retencao INT
)
BEGIN
    DELETE FROM clusters
    WHERE status = 'rejected'
      AND created_at < DATE_SUB(NOW(), INTERVAL p_dias_retencao DAY);

    SELECT ROW_COUNT() AS clusters_removidos;
END //


-- ------------------------------------------------------------
-- 5.2  sp_estatisticas_gerais
-- Retorna contadores rápidos para monitoramento.
-- Uso: CALL sp_estatisticas_gerais();
-- ------------------------------------------------------------
CREATE PROCEDURE IF NOT EXISTS sp_estatisticas_gerais()
BEGIN
    SELECT
        (SELECT COUNT(*) FROM upload_batches)                           AS total_importacoes,
        (SELECT COUNT(*) FROM records)                                  AS total_apontamentos,
        (SELECT COUNT(*) FROM records WHERE status = 'pending')         AS apontamentos_pendentes,
        (SELECT COUNT(*) FROM records WHERE status = 'confirmed')       AS apontamentos_confirmados,
        (SELECT COUNT(*) FROM records WHERE question_flag = 1)          AS apontamentos_questionados,
        (SELECT COUNT(*) FROM clusters WHERE status = 'pending')        AS clusters_pendentes,
        (SELECT COUNT(*) FROM clusters WHERE status = 'confirmed')      AS clusters_confirmados,
        (SELECT COUNT(*) FROM clusters WHERE status = 'rejected')       AS clusters_rejeitados,
        (SELECT COUNT(*) FROM canonical_failures)                       AS modos_falha_catalogados,
        (SELECT COUNT(*) FROM dedup_jobs WHERE status = 'done')         AS jobs_dedup_completos,
        (SELECT COUNT(*) FROM dedup_jobs WHERE status = 'error')        AS jobs_dedup_com_erro;
END //

DELIMITER ;


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║  6. DADOS INICIAIS (seed) — OPCIONAL                          ║
-- ╚═══════════════════════════════════════════════════════════════╝

-- Descomente para pré-popular canais de rádio de exemplo:
/*
INSERT INTO radio_channels (linha, turno, canal) VALUES
    ('LINHA001', '1', '3'),
    ('LINHA001', '2', '3'),
    ('LINHA001', '3', '4'),
    ('LINHA002', '1', '5'),
    ('LINHA002', '2', '5'),
    ('LINHA002', '3', '6'),
    ('LINHA003', '1', '7'),
    ('LINHA003', '2', '7'),
    ('LINHA003', '3', '8'),
    ('LINHA004', '1', '9'),
    ('LINHA004', '2', '9'),
    ('LINHA004', '3', '10'),
    ('LINHA005', '1', '11'),
    ('LINHA005', '2', '11'),
    ('LINHA005', '3', '12'),
    ('LINHA006', '1', '13'),
    ('LINHA006', '2', '13'),
    ('LINHA006', '3', '14'),
    ('MULTI009', '1', '15'),
    ('MULTI009', '2', '15'),
    ('MULTI009', '3', '16')
ON DUPLICATE KEY UPDATE canal = VALUES(canal);
*/


-- ============================================================
-- FIM DO DDL — KOFBR v2.0
--
-- Resumo das tabelas:
--   upload_batches      → Lotes de importação de planilhas
--   canonical_failures  → Taxonomia de modos de falha
--   records             → Apontamentos de falha (tabela core)
--   clusters            → Propostas de agrupamento (dedup)
--   dedup_jobs          → Jobs de processamento TF-IDF
--   bulk_confirm_jobs   → Jobs de confirmação em massa
--   radio_channels      → Config de canal de rádio
--
-- Views:
--   vw_drive_diario         → Drive Diário (clusters por dia)
--   vw_pareto_equipamento   → Pareto de falhas por equipamento
--   vw_resumo_importacoes   → Auditoria de importações
--
-- Procedures:
--   sp_limpar_clusters_rejeitados(dias)  → Limpeza periódica
--   sp_estatisticas_gerais()             → Monitoramento rápido
-- ============================================================
