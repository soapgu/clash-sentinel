import { noopLogger } from '../logging.js';
import { SqliteConnection, type SqliteStoreOptions } from './connection.js';
import { DiagnosisRepository } from './diagnosis-repository.js';
import { EventRepository } from './event-repository.js';
import { HealthRepository } from './health-repository.js';
import { SettingsRepository } from './settings-repository.js';
import { SiteRepository } from './site-repository.js';
import { TaskRepository } from './task-repository.js';

/** SQLite 连接及六个领域仓储的组合根。 */
export class SqliteStore {
  readonly settings: SettingsRepository;
  readonly health: HealthRepository;
  readonly sites: SiteRepository;
  readonly diagnoses: DiagnosisRepository;
  readonly tasks: TaskRepository;
  readonly events: EventRepository;

  private readonly connection: SqliteConnection;

  constructor(options: SqliteStoreOptions = {}) {
    this.connection = new SqliteConnection(options);
    const database = this.connection.database;
    const redactSensitiveData = options.redactSensitiveData ?? true;
    try {
      this.settings = new SettingsRepository(database);
      this.health = new HealthRepository(database);
      this.sites = new SiteRepository(database);
      this.diagnoses = new DiagnosisRepository(database);
      this.tasks = new TaskRepository(database, redactSensitiveData);
      this.events = new EventRepository(database, redactSensitiveData);
    } catch (error) {
      this.connection.close();
      (options.logger ?? noopLogger).error(
        'storage:sqlite',
        'repository initialization failed',
        { error },
      );
      throw error;
    }
  }

  transaction<T>(callback: () => T): T {
    return this.connection.transaction(callback);
  }

  close() {
    this.connection.close();
  }
}
