import { AbstractModule } from 'adapt-authoring-core';
/**
 * Module for making course content compatible with spoor
 * @extends {AbstractModule}
 */
class SpoorTrackingModule extends AbstractModule {
  /** @override */
  async init() {
    this.initRoutes();

    const [content, mongodb] = await this.app.waitForModule('content', 'mongodb');
    /**
     * Cached module instance for easy access
     * @type {ContentModule}
     */
    this.content = content;
    /**
     * Cached module instance for easy access
     * @type {MongoDBModule}
     */
    this.db = mongodb;

    content.preInsertHook.tap(this.insertTrackingId.bind(this));
  }
  /**
   * Set up the router
   */
  async initRoutes() {
    const [auth, server] = await this.app.waitForModule('auth', 'server');
    server.api.createChildRouter('spoortracking').addRoute({
      route: '/reset/:_courseId',
      handlers: { post: this.resetTrackingIds.bind(this) }
    });
    auth.secureRoute('/api/spoortracking/reset/:_courseId', 'post', 'write:content');
  }
  /**
   * Adds the latest tracking ID to a block
   * @param {Object} data The block data to update
   */
  async insertTrackingId(data) {
    if(data._type !== 'block' || data._trackingId > -1) {
      return;
    }
    const { _latestTrackingId } = await this.db.update(
      this.content.collectionName,
      { _id: data._courseId },
      { $inc: { _latestTrackingId: 1 } }
    );
    data._trackingId = _latestTrackingId;
  }
  /**
   * Resets all tracking IDs for a single course
   * @param {external:express~Request} req
   * @param {external:express~Response} res
   * @param {Function} next
   */
  async resetTrackingIds(req, res, next) {
    try {
      await this.content.update({ _id: req.params._courseId }, { _trackingId: -1 });
      const blocks = await this.content.find({ _type: 'block', _courseId: req.params._courseId });
      for(const b of blocks) await this.insertTrackingId(b);
      res.sendStatus(204);
    } catch(e) {
      return next(e);
    }
  }
}

export default SpoorTrackingModule;