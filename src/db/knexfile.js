module.exports = {
  development: {
    client: 'sqlite3',
    connection: {
      filename: './data/dev.sqlite'
    },
    useNullAsDefault: true
  }
};