// Quick test to verify interview routes are loaded
const interviewsRoutes = require('./routes/interviews.routes');

console.log('Interview routes object:', interviewsRoutes);
console.log('Interview routes stack:', interviewsRoutes.stack);

if (interviewsRoutes.stack) {
  console.log('\nRegistered routes:');
  interviewsRoutes.stack.forEach((layer) => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(', ').toUpperCase();
      console.log(`  ${methods} ${layer.route.path}`);
    }
  });
}
