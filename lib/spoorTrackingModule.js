const { AbstractModule } = require('adapt-authoring-core');
/**
 * Module which handles tagging
 * @extends {AbstractModule}
 */
class SpoorTrackingModule extends AbstractModule {
  constructor(...args) {
    super(...args);
    this.setReady();
  }
}

module.exports = SpoorTrackingModule;
