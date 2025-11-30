import { Db, MongoClient } from 'mongodb';

module.exports = {
  async up(db: Db, client: MongoClient) {
    // Add sourceTable field to all existing SLOs, defaulting to 'otel_logs'
    await db
      .collection('slos')
      .updateMany(
        { sourceTable: { $exists: false } },
        { $set: { sourceTable: 'otel_logs' } },
      );
  },
  async down(db: Db, client: MongoClient) {
    // Remove sourceTable field from all SLOs
    await db.collection('slos').updateMany({}, { $unset: { sourceTable: '' } });
  },
};

